import { getSchema } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import mammoth from 'mammoth/mammoth.browser.js';
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun,
  LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, Tab, TextRun, WidthType,
} from 'docx';
import type { IParagraphOptions, IRunOptions, NumberingDefinition, ParagraphChild } from 'docx';
import { inspectRaster, isSafeImage, isSafeLink, MAX_BACKUP_BYTES, MAX_IMAGE_BYTES, validateContent, validateDocument } from './data';
import type { DocumentRecord } from './data';
import { createExtensions } from './editor';
import { decodeLocalRaster } from './image-preflight';
import { prepareDocxArchive } from './docx-archive';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MAX_DOCX_BYTES = 12 * 1024 * 1024;

export interface DocxImportResult {
  title: string;
  content: JSONContent;
  warnings: string[];
}
export interface DocxExportResult {
  blob: Blob;
  filename: string;
  warnings: string[];
}

/** Conversion is atomic: failures never return partially validated content. */
export class DocxError extends Error {
  constructor(public readonly code: 'file' | 'archive' | 'conversion' | 'content' | 'image', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DocxError';
  }
}

const IMPORT_LIMITATION = 'Impor Word bukan salinan penuh: tata letak halaman, font, warna, header/footer, catatan kaki/endnote, komentar, revisi, objek, rumus, dan gaya khusus dapat hilang atau disederhanakan. Penomoran dapat dimulai ulang; ukuran gambar dan lebar kolom dapat berubah. Periksa hasil sebelum menyimpan.';
const EXPORT_LIMITATION = 'Ekspor Word mempertahankan isi dan format dasar editor, bukan tata letak identik. Kutipan, kode, dan garis pemisah memakai gaya Word sederhana; bahasa kode, metadata tautan, lebar/alignment sel, dan pengelompokan kutipan mungkin tidak dipulihkan saat impor ulang. Font dan pemenggalan halaman bergantung pada aplikasi pembaca.';
const MAX_HTML_BYTES = 24 * 1024 * 1024;
const MAX_HTML_NODES = 100_000;
const MAX_HTML_DEPTH = 64;
let editorSchema: Schema | undefined;

function checkedContent(value: unknown): JSONContent {
  const content = validateContent(value);
  editorSchema ??= getSchema(createExtensions());
  const node = editorSchema.nodeFromJSON(content);
  node.check();
  // Match DocumentLimits after schema defaults are materialized, not just the
  // smaller incoming JSON. Reserve the same 8192 bytes for document metadata.
  const normalized = validateContent(node.toJSON());
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_BACKUP_BYTES - 8192) {
    throw new DocxError('content', 'Isi dokumen melebihi batas editor termasuk cadangan metadata.');
  }
  return normalized;
}

function warn(warnings: string[], message: string): void {
  if (warnings.includes(message)) return;
  if (warnings.length < 99) warnings.push(message);
  else if (warnings.length === 99) warnings.push('Peringatan tambahan tidak ditampilkan. Periksa seluruh hasil konversi.');
}

/** Drops controls and replaces isolated surrogates, retaining complete Unicode code points. */
function cleanName(value: string, maximum: number): string {
  let result = '';
  for (const character of value) {
    if (/[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/u.test(character)) continue;
    const code = character.codePointAt(0)!;
    const safe = code >= 0xd800 && code <= 0xdfff ? '\ufffd' : character;
    if (result.length + safe.length > maximum) break;
    result += safe;
  }
  return result.trim();
}

/** A download basename, never a path. The extension occurs exactly once. */
export function docxFilename(title: string): string {
  const name = cleanName(title, 120).replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '').replace(/(?:\.docx)+$/i, '').replace(/[. ]+$/g, '').trim();
  const base = !name || /^\.+$/.test(name) ? 'Dokumen' : name;
  return `${/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `_${base}` : base}.docx`;
}

async function readFile(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  const { promise, resolve, reject } = Promise.withResolvers<ArrayBuffer>();
  const reader = new FileReader();
  reader.onerror = () => reject(new DocxError('file', 'Berkas Word tidak dapat dibaca.'));
  reader.onabort = () => reject(new DocxError('file', 'Pembacaan berkas Word dibatalkan.'));
  reader.onload = () => reader.result instanceof ArrayBuffer
    ? resolve(reader.result) : reject(new DocxError('file', 'Berkas Word tidak dapat dibaca.'));
  reader.readAsArrayBuffer(file);
  return promise;
}

interface MammothNode {
  type: string;
  children?: MammothNode[];
  styleId?: string | null;
  styleName?: string | null;
  alignment?: string | null;
  indent?: { start?: string | null; firstLine?: string | null; hanging?: string | null };
  numbering?: { level: string; isOrdered: boolean } | null;
}
interface ParagraphMetadata {
  kind: 'paragraph' | 'heading' | 'codeBlock' | 'blockquote' | 'horizontalRule';
  attrs: Record<string, number | string>;
}

/**
 * Mammoth intentionally drops direct paragraph formatting. Its supported document
 * transform and style-map hooks carry only bounded, editor-supported metadata.
 * The mutable style map is read after transformDocument in pinned Mammoth 1.13.
 */
function paragraphTransform(styleMap: string[], metadata: Map<string, ParagraphMetadata>, warnings: string[]) {
  let count = 0;
  const styles = new Map<string, string>();
  return (root: MammothNode): MammothNode => {
    const walk = (node: MammothNode, depth: number): void => {
      if (depth > MAX_HTML_DEPTH || ++count > MAX_HTML_NODES) throw new DocxError('content', 'Struktur Word terlalu rumit.');
      if (node.children) node.children = node.children.filter(child => {
        if (child.type !== 'noteReference' && child.type !== 'commentReference') return true;
        warn(warnings, 'Catatan kaki, endnote, dan komentar tidak diimpor.');
        return false;
      });
      if (node.type === 'paragraph') {
        const original = `${node.styleId ?? ''} ${node.styleName ?? ''}`;
        const heading = /(?:^|\s)heading\s*([1-9])(?:\s|$)/i.exec(original);
        let kind: ParagraphMetadata['kind'] = heading ? 'heading' : 'paragraph';
        if (/EditorCodeBlock/.test(original)) kind = 'codeBlock';
        if (/EditorBlockquote|(?:^|\s)(?:quote|intense quote)(?:\s|$)/i.test(original)) kind = 'blockquote';
        if (/EditorHorizontalRule/.test(original)) kind = 'horizontalRule';
        const attrs: ParagraphMetadata['attrs'] = {};
        if (heading) {
          attrs.level = Math.min(3, Number(heading[1]));
          if (Number(heading[1]) > 3) warn(warnings, 'Heading di atas tingkat 3 diubah menjadi heading tingkat 3.');
        }
        const alignment = node.alignment === 'both' ? 'justify' : node.alignment;
        if (alignment && ['left', 'center', 'right', 'justify'].includes(alignment)) attrs.textAlign = alignment;
        const start = Number(node.indent?.start ?? 0);
        const quoteIndent = /(?:^|\s)EditorBlockquote(?:\s|$)/.test(original) ? 720 : 0;
        if (Number.isFinite(start) && start > 0 && !node.numbering) attrs.indent = Math.max(0, Math.min(8, Math.round((start - quoteIndent) / 360)));
        const level = node.numbering ? Number(node.numbering.level) : undefined;
        if (level !== undefined && (!Number.isInteger(level) || level < 0 || level > 8)) throw new DocxError('content', 'Tingkat daftar Word tidak didukung.');
        const key = JSON.stringify({ kind, attrs, level, ordered: node.numbering?.isOrdered });
        let id = styles.get(key);
        if (!id) {
          id = `EditorImport${metadata.size}`;
          const className = `docx-p-${metadata.size}`;
          metadata.set(className, { kind, attrs });
          styles.set(key, id);
          const tag = kind === 'heading' ? `h${attrs.level}` : kind === 'codeBlock' ? 'pre' : kind === 'horizontalRule' ? 'hr' : 'p';
          let path = `${tag}.${className}:fresh`;
          if (node.numbering) path = `${'ul|ol > li > '.repeat(level!)}${node.numbering.isOrdered ? 'ol' : 'ul'} > li:fresh > ${path}`;
          styleMap.push(`p.${id} => ${path}`);
        }
        node.styleId = id;
        node.styleName = id;
      }
      for (const child of node.children ?? []) walk(child, depth + 1);
    };
    walk(root, 0);
    return root;
  };
}

function appendText(output: JSONContent[], text: string, marks: NonNullable<JSONContent['marks']>): void {
  if (!text) return;
  const previous = output[output.length - 1];
  if (previous?.type === 'text' && JSON.stringify(previous.marks ?? []) === JSON.stringify(marks)) previous.text = (previous.text ?? '') + text;
  else output.push({ type: 'text', text, ...(marks.length ? { marks } : {}) });
}

/** Never inserts converter HTML into the live DOM; only allowlisted JSON escapes. */
function sanitizeHtml(html: string, metadata: Map<string, ParagraphMetadata>, warnings: string[]): JSONContent {
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) throw new DocxError('content', 'Hasil konversi Word terlalu besar.');
  // Template contents cannot execute scripts or load subresources. A detached
  // DOMParser document is not enough: browsers may still load its img/iframe URLs.
  const template = document.createElement('template');
  template.innerHTML = html;
  let visited = 0;
  const blocked: Record<string, true> = {
    SCRIPT: true, STYLE: true, IFRAME: true, OBJECT: true, EMBED: true, SVG: true, MATH: true,
    FORM: true, INPUT: true, VIDEO: true, AUDIO: true, LINK: true, META: true, BASE: true,
  };
  // SVG/MathML tag names are not necessarily uppercase. Reject their entire
  // namespace subtree, including HTML nested in foreignObject/annotation-xml.
  const htmlTag = (element: Element): string => element.namespaceURI === 'http://www.w3.org/1999/xhtml' ? element.tagName.toUpperCase() : '';
  const guard = (depth: number): void => {
    if (depth > MAX_HTML_DEPTH || ++visited > MAX_HTML_NODES) throw new DocxError('content', 'Hasil konversi Word terlalu rumit.');
  };
  const getMetadata = (element: Element): ParagraphMetadata | undefined => {
    for (const className of element.classList) {
      const value = metadata.get(className);
      if (value) return value;
    }
    return undefined;
  };
  const image = (element: Element): JSONContent[] => {
    const src = element.getAttribute('src') ?? '';
    if (!isSafeImage(src)) {
      warn(warnings, 'Gambar eksternal, rusak, atau berformat tidak didukung diabaikan.');
      return [];
    }
    return [{ type: 'image', attrs: { src, alt: cleanName(element.getAttribute('alt') ?? '', 2000), title: null } }];
  };
  const inline = (nodes: Iterable<Node>, marks: NonNullable<JSONContent['marks']>, depth: number): JSONContent[] => {
    const output: JSONContent[] = [];
    for (const node of nodes) {
      guard(depth);
      if (node.nodeType === 3) { appendText(output, node.textContent ?? '', marks); continue; }
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      const tag = htmlTag(element);
      if (!tag || Object.hasOwn(blocked, tag)) { warn(warnings, 'Elemen aktif atau format di luar skema editor diabaikan.'); continue; }
      if (tag === 'IMG') { output.push(...image(element)); continue; }
      if (tag === 'BR') { output.push({ type: 'hardBreak', ...(marks.length ? { marks } : {}) }); continue; }
      let next = [...marks];
      const markType = ({ STRONG: 'bold', B: 'bold', EM: 'italic', I: 'italic', U: 'underline', S: 'strike', DEL: 'strike', STRIKE: 'strike', CODE: 'code' } as Record<string, string>)[tag];
      if (markType === 'code') next = [{ type: 'code' }];
      else if (markType && !next.some(mark => mark.type === 'code' || mark.type === markType)) next.push({ type: markType });
      if (tag === 'A') {
        const href = element.getAttribute('href') ?? '';
        if (isSafeLink(href) && !next.some(mark => mark.type === 'code')) {
          next = next.filter(mark => mark.type !== 'link');
          next.push({ type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer nofollow', class: null } });
        } else if (href) warn(warnings, 'Tautan internal atau tidak aman diubah menjadi teks biasa.');
      }
      for (const child of inline(element.childNodes, next, depth + 1)) {
        if (child.type === 'text') appendText(output, child.text ?? '', child.marks ?? []);
        else output.push(child);
      }
    }
    return output;
  };
  const paragraphs = (children: JSONContent[], attrs: Record<string, number | string> = {}, type = 'paragraph'): JSONContent[] => {
    const result: JSONContent[] = [];
    let pending: JSONContent[] = [];
    const flush = (): void => {
      result.push({ type, ...(Object.keys(attrs).length ? { attrs } : {}), ...(pending.length ? { content: pending } : {}) });
      pending = [];
    };
    for (const child of children) {
      if (child.type === 'image') {
        if (pending.length) flush();
        result.push(child);
        warn(warnings, 'Gambar dalam baris dipindahkan menjadi blok gambar.');
      } else pending.push(child);
    }
    if (pending.length || !result.length) flush();
    return result;
  };
  const blocks = (nodes: Iterable<Node>, depth: number): JSONContent[] => {
    const output: JSONContent[] = [];
    let pending: Node[] = [];
    const flush = (): void => {
      if (!pending.length) return;
      const children = inline(pending, [], depth + 1);
      if (children.some(child => child.type !== 'text' || child.text?.trim())) output.push(...paragraphs(children));
      pending = [];
    };
    for (const node of nodes) {
      guard(depth);
      if (node.nodeType !== 1) { if (node.nodeType === 3) pending.push(node); continue; }
      const element = node as Element;
      const tag = htmlTag(element);
      if (!tag || Object.hasOwn(blocked, tag)) { warn(warnings, 'Elemen aktif atau format di luar skema editor diabaikan.'); continue; }
      if (/^(?:STRONG|B|EM|I|U|S|DEL|STRIKE|CODE|A|SPAN|BR)$/.test(tag)) { pending.push(node); continue; }
      flush();
      if (/^(?:P|H[1-6])$/.test(tag)) {
        const info = getMetadata(element);
        const type = tag.startsWith('H') ? 'heading' : 'paragraph';
        const attrs = { ...(info?.attrs ?? {}), ...(type === 'heading' ? { level: Math.min(3, Number(tag[1])) } : {}) };
        const converted = paragraphs(inline(element.childNodes, [], depth + 1), attrs, type);
        output.push(...(info?.kind === 'blockquote' ? [{ type: 'blockquote', content: converted }] : converted));
      } else if (tag === 'PRE') {
        const children = inline(element.childNodes, [], depth + 1);
        const text = children.map(child => child.type === 'hardBreak' ? '\n' : child.text ?? '').join('');
        output.push({ type: 'codeBlock', ...(text ? { content: [{ type: 'text', text }] } : {}) });
        if (children.some(child => child.type === 'image')) warn(warnings, 'Gambar di dalam blok kode diabaikan.');
      } else if (tag === 'IMG') output.push(...image(element));
      else if (tag === 'HR') output.push({ type: 'horizontalRule' });
      else if (tag === 'BLOCKQUOTE') {
        const content = blocks(element.childNodes, depth + 1);
        output.push({ type: 'blockquote', content: content.length ? content : [{ type: 'paragraph' }] });
      } else if (tag === 'UL' || tag === 'OL') {
        const items = Array.from(element.children).filter(child => htmlTag(child) === 'LI').map(child => {
          const content = blocks(child.childNodes, depth + 1);
          if (content[0]?.type !== 'paragraph') content.unshift({ type: 'paragraph' });
          return { type: 'listItem', content };
        });
        if (items.length) output.push({ type: tag === 'OL' ? 'orderedList' : 'bulletList', ...(tag === 'OL' ? { attrs: { start: 1, type: '1' } } : {}), content: items });
      } else if (tag === 'TABLE') {
        const rows: Element[] = [];
        for (const child of element.children) {
          if (htmlTag(child) === 'TR') rows.push(child);
          else if (['THEAD', 'TBODY', 'TFOOT'].includes(htmlTag(child))) rows.push(...Array.from(child.children).filter(row => htmlTag(row) === 'TR'));
        }
        const content = rows.map(row => ({
          type: 'tableRow',
          content: Array.from(row.children).filter(cell => ['TH', 'TD'].includes(htmlTag(cell))).map(cell => {
            const childBlocks = blocks(cell.childNodes, depth + 1);
            return {
              type: htmlTag(cell) === 'TH' ? 'tableHeader' : 'tableCell',
              attrs: { colspan: Number(cell.getAttribute('colspan') ?? 1), rowspan: Number(cell.getAttribute('rowspan') ?? 1), colwidth: null },
              content: childBlocks.length ? childBlocks : [{ type: 'paragraph' }],
            };
          }),
        }));
        if (content.length) output.push({ type: 'table', content });
      } else {
        warn(warnings, 'Sebagian struktur Word disederhanakan menjadi blok editor.');
        output.push(...blocks(element.childNodes, depth + 1));
      }
    }
    flush();
    return output;
  };
  const content = blocks(template.content.childNodes, 0);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

function imageSources(content: JSONContent): string[] {
  const sources = new Set<string>();
  const visit = (node: JSONContent): void => {
    if (node.type === 'image') sources.add(node.attrs!.src as string);
    for (const child of node.content ?? []) visit(child);
  };
  visit(content);
  return [...sources];
}

/**
 * Browser-only, local, main-body DOCX import. Accepts .docx (not .doc/.docm).
 * The ZIP/XML envelope is bounded before Mammoth runs; embedded style maps and
 * external file access are disabled. Converter HTML is never rendered. Both
 * application validation and the actual ProseMirror schema must accept the
 * sanitized result, and every retained raster must decode before return.
 * Warnings are plain display strings, not HTML. No store/editor is mutated.
 */
export async function importDocx(file: File): Promise<DocxImportResult> {
  if (!file || typeof file.name !== 'string' || !/\.docx$/i.test(file.name)
    || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_DOCX_BYTES) {
    throw new DocxError('file', 'Pilih berkas .docx yang tidak kosong dengan ukuran maksimal 12 MiB.');
  }
  if (file.type && ![DOCX_MIME, 'application/octet-stream', 'application/zip', 'application/x-zip-compressed'].includes(file.type.toLowerCase())) {
    throw new DocxError('file', 'Jenis berkas bukan dokumen Word .docx.');
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const buffer = await readFile(file);
    if (buffer.byteLength !== file.size || buffer.byteLength > MAX_DOCX_BYTES) throw new Error('File size changed while reading.');
    bytes = new Uint8Array(buffer);
  } catch (cause) {
    throw new DocxError('file', 'Berkas Word tidak dapat dibaca.', { cause });
  }
  const warnings = [IMPORT_LIMITATION];
  try {
    const archive = prepareDocxArchive(bytes);
    bytes = archive.bytes;
    for (const warning of archive.warnings) warn(warnings, warning.message);
  } catch (cause) {
    throw new DocxError('archive', 'Paket Word tidak valid, tidak didukung, atau melebihi batas keamanan.', { cause });
  }
  const metadata = new Map<string, ParagraphMetadata>();
  const styleMap = ['u => u', 'r.EditorInlineCode => code'];
  let html: string;
  let importedImageBytes = 0;
  let imageBudgetExceeded = false;
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer }, {
      includeEmbeddedStyleMap: false,
      includeDefaultStyleMap: true,
      externalFileAccess: false,
      ignoreEmptyParagraphs: false,
      styleMap,
      transformDocument: paragraphTransform(styleMap, metadata, warnings),
      convertImage: mammoth.images.imgElement(async image => {
        if (imageBudgetExceeded) return { src: '' };
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.contentType.toLowerCase())) {
          warn(warnings, 'Gambar non-raster atau format gambar yang tidak didukung diabaikan.');
          return { src: '' };
        }
        const buffer = await image.readAsArrayBuffer();
        importedImageBytes += buffer.byteLength;
        if (importedImageBytes > MAX_DOCX_BYTES) {
          imageBudgetExceeded = true;
          return { src: '' };
        }
        if (buffer.byteLength > MAX_IMAGE_BYTES) {
          warn(warnings, 'Gambar yang melebihi batas 2 MiB diabaikan.');
          return { src: '' };
        }
        const source = `data:${image.contentType.toLowerCase()};base64,${bytesToBase64(new Uint8Array(buffer))}`;
        if (!isSafeImage(source)) {
          warn(warnings, 'Gambar rusak atau melebihi batas resolusi diabaikan.');
          return { src: '' };
        }
        return { src: source };
      }),
    });
    if (imageBudgetExceeded) throw new DocxError('content', 'Total gambar Word melebihi batas editor.');
    html = result.value;
    for (const message of result.messages) {
      // Untrusted library diagnostics remain bounded text, never markup.
      warn(warnings, `Konversi Word: ${cleanName(message.message, 1000)}`);
    }
  } catch (cause) {
    throw new DocxError('conversion', 'Isi dokumen Word tidak dapat dikonversi.', { cause });
  }
  let content: JSONContent;
  try { content = checkedContent(sanitizeHtml(html, metadata, warnings)); }
  catch (cause) { throw new DocxError('content', 'Hasil impor Word tidak sesuai skema atau batas editor.', { cause }); }
  try { for (const source of imageSources(content)) await decodeLocalRaster(source); }
  catch (cause) { throw new DocxError('image', 'Gambar Word tidak dapat didekode dengan aman. Tidak ada dokumen yang diimpor.', { cause }); }
  return { title: cleanName(file.name.split(/[\\/]/).pop()!.replace(/\.docx$/i, ''), 200) || 'Dokumen impor', content, warnings };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

interface ExportImage {
  data: Uint8Array<ArrayBuffer>;
  type: 'png' | 'jpg' | 'gif';
  width: number;
  height: number;
}

async function webpAsPng(source: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const image = new Image();
  const finish = (): void => { window.clearTimeout(timer); image.onload = null; image.onerror = null; };
  const timer = window.setTimeout(() => { finish(); image.src = ''; reject(new Error('Image conversion timed out.')); }, 10_000);
  image.onerror = () => { finish(); reject(new Error('Image cannot be decoded.')); };
  image.onload = () => {
    finish();
    const canvas = document.createElement('canvas');
    try {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable.');
      context.drawImage(image, 0, 0);
      const result = canvas.toDataURL('image/png');
      if (!isSafeImage(result)) throw new Error('Converted image exceeds the raster limits.');
      resolve(result);
    } catch (error) { reject(error); }
    finally { canvas.width = 0; canvas.height = 0; }
  };
  image.src = source;
  return promise;
}

async function prepareImages(content: JSONContent, warnings: string[]): Promise<Map<string, ExportImage>> {
  const images = new Map<string, ExportImage>();
  for (const source of imageSources(content)) {
    await decodeLocalRaster(source);
    const info = inspectRaster(source)!;
    let embedded = source;
    if (source.startsWith('data:image/webp;')) {
      embedded = await webpAsPng(source);
      warn(warnings, 'Gambar WebP dikonversi ke PNG agar dapat dibuka di Word.');
    }
    const mime = embedded.slice(11, embedded.indexOf(';'));
    if (mime === 'gif') warn(warnings, 'Animasi GIF mungkin ditampilkan sebagai gambar diam oleh pembaca Word.');
    images.set(source, {
      data: Uint8Array.from(atob(embedded.slice(embedded.indexOf(',') + 1)), character => character.charCodeAt(0)),
      type: mime === 'jpeg' ? 'jpg' : mime === 'gif' ? 'gif' : 'png',
      width: info.width, height: info.height,
    });
  }
  return images;
}

interface ExportContext {
  quoteDepth: number;
  listDepth: number;
  numbering?: { reference: string; level: number };
  continuation?: boolean;
  cellAlignment?: string;
}

function buildWord(content: JSONContent, title: string, images: Map<string, ExportImage>, warnings: string[]): Document {
  const numbering: NumberingDefinition[] = [];
  const alignments: Record<string, typeof AlignmentType.LEFT | typeof AlignmentType.CENTER | typeof AlignmentType.RIGHT | typeof AlignmentType.JUSTIFIED> = {
    left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED,
  };
  const runs = (nodes: JSONContent[], forceCode = false): ParagraphChild[] => nodes.flatMap((node): ParagraphChild[] => {
    const marks = node.marks ?? [];
    const has = (type: string): boolean => marks.some(mark => mark.type === type);
    const options: IRunOptions = {
      bold: has('bold'), boldComplexScript: has('bold'), italics: has('italic'), italicsComplexScript: has('italic'),
      strike: has('strike'), ...(has('underline') ? { underline: {} } : {}),
      ...(forceCode || has('code') ? { font: 'Courier New', style: 'EditorInlineCode' } : {}),
    };
    const children = node.type === 'hardBreak' ? [new TextRun({ ...options, break: 1 })]
      : (node.text ?? '').split(/(\r\n|\r|\n|\t)/).filter(Boolean).map(part => part === '\t'
        ? new TextRun({ ...options, children: [new Tab()] })
        : /^[\r\n]+$/.test(part) ? new TextRun({ ...options, break: 1 }) : new TextRun({ ...options, text: part }));
    const link = marks.find(mark => mark.type === 'link');
    return link ? [new ExternalHyperlink({ link: link.attrs!.href as string, children })] : children;
  });
  const paragraph = (node: JSONContent, context: ExportContext): Paragraph => {
    const indent = Number(node.attrs?.indent ?? 0) * 360 + context.quoteDepth * 720
      + (context.continuation ? Math.min(9, context.listDepth) * 720 : 0);
    const heading = node.type === 'heading' ? [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][Number(node.attrs?.level ?? 1) - 1] : undefined;
    const code = node.type === 'codeBlock';
    const options: IParagraphOptions = {
      children: runs(node.content ?? [], code), heading,
      ...(node.attrs?.textAlign || context.cellAlignment ? { alignment: alignments[(node.attrs?.textAlign || context.cellAlignment) as string] } : {}),
      ...(indent ? { indent: { left: indent } } : {}),
      ...(context.numbering ? { numbering: context.numbering } : {}),
      ...(code ? { style: 'EditorCodeBlock' } : context.quoteDepth && !heading ? { style: 'EditorBlockquote' } : {}),
    };
    return new Paragraph(options);
  };
  const blocks = (nodes: JSONContent[], context: ExportContext): (Paragraph | Table)[] => nodes.flatMap((node): (Paragraph | Table)[] => {
    if (['paragraph', 'heading', 'codeBlock'].includes(node.type!)) return [paragraph(node, context)];
    if (node.type === 'image') {
      const entry = images.get(node.attrs!.src as string)!;
      const width = Number(node.attrs?.width ?? (node.attrs?.height ? entry.width * Number(node.attrs.height) / entry.height : entry.width));
      const height = Number(node.attrs?.height ?? (node.attrs?.width ? entry.height * Number(node.attrs.width) / entry.width : entry.height));
      if (width > 10_000 || height > 10_000) throw new DocxError('image', 'Ukuran tampilan gambar melebihi batas 10000 piksel.');
      return [new Paragraph({ children: [new ImageRun({
        type: entry.type, data: entry.data, transformation: { width, height },
        altText: { name: (node.attrs?.alt as string | null) || 'Gambar', description: (node.attrs?.alt as string | null) ?? '', title: (node.attrs?.title as string | null) ?? '' },
      })] })];
    }
    if (node.type === 'horizontalRule') return [new Paragraph({ style: 'EditorHorizontalRule', border: { bottom: { color: '808080', style: BorderStyle.SINGLE, size: 6 } } })];
    if (node.type === 'blockquote') return blocks(node.content ?? [], { ...context, numbering: undefined, quoteDepth: context.quoteDepth + 1 });
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      const level = Math.min(8, context.listDepth);
      if (context.listDepth > 8) warn(warnings, 'Daftar di atas sembilan tingkat disederhanakan untuk Word.');
      const reference = `editor-list-${numbering.length}`;
      const ordered = node.type === 'orderedList';
      const formats: Record<string, typeof LevelFormat.DECIMAL | typeof LevelFormat.LOWER_LETTER | typeof LevelFormat.UPPER_LETTER | typeof LevelFormat.LOWER_ROMAN | typeof LevelFormat.UPPER_ROMAN> = {
        '1': LevelFormat.DECIMAL, a: LevelFormat.LOWER_LETTER, A: LevelFormat.UPPER_LETTER, i: LevelFormat.LOWER_ROMAN, I: LevelFormat.UPPER_ROMAN,
      };
      const start = Number(node.attrs?.start ?? 1);
      if (start > 2147483647) warn(warnings, 'Nomor awal daftar dibatasi ke 2147483647 sesuai batas penomoran Word.');
      numbering.push({ reference, levels: Array.from({ length: 9 }, (_, index) => ({
        level: index, format: ordered ? formats[(node.attrs?.type as string | null) ?? '1'] : LevelFormat.BULLET,
        text: ordered ? `%${index + 1}.` : ['•', '◦', '▪'][index % 3], start: Math.min(start, 2147483647),
        alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: (index + 1) * 720, hanging: 360 } } },
      })) });
      return (node.content ?? []).flatMap(item => (item.content ?? []).flatMap((child, index) => blocks([child], {
        ...context, listDepth: context.listDepth + 1,
        numbering: index === 0 ? { reference, level } : undefined, continuation: index > 0 && !['bulletList', 'orderedList'].includes(child.type!),
      })));
    }
    if (node.type === 'table') {
      const occupiedUntil: number[] = [];
      const columnWidths: number[] = [];
      let columnCount = 0;
      let hasWidths = false;
      for (const [rowIndex, row] of (node.content ?? []).entries()) {
        let column = 0;
        for (const cell of row.content ?? []) {
          while ((occupiedUntil[column] ?? 0) > rowIndex) column++;
          const colspan = Number(cell.attrs?.colspan ?? 1);
          const widths = cell.attrs?.colwidth as number[] | null | undefined;
          for (let offset = 0; offset < colspan; offset++) {
            occupiedUntil[column + offset] = rowIndex + Number(cell.attrs?.rowspan ?? 1);
            if (widths?.[offset]) { columnWidths[column + offset] = widths[offset] * 15; hasWidths = true; }
          }
          column += colspan;
          columnCount = Math.max(columnCount, column);
        }
      }
      const resolvedWidths = hasWidths ? Array.from({ length: columnCount }, (_, index) => columnWidths[index] ?? 1440) : undefined;
      const rows = (node.content ?? []).map(row => new TableRow({
        // Omit false: docx emits w:tblHeader w:val="off", which Mammoth
        // interprets as a header based on element presence alone.
        ...(row.content?.every(cell => cell.type === 'tableHeader') ? { tableHeader: true } : {}),
        children: (row.content ?? []).map(cell => {
          const children = blocks(cell.content ?? [], { ...context, numbering: undefined, cellAlignment: cell.attrs?.align as string | undefined });
          // OOXML cells must end in a paragraph, including cells ending in a nested table.
          if (!(children[children.length - 1] instanceof Paragraph)) children.push(new Paragraph({}));
          return new TableCell({
            children, columnSpan: Number(cell.attrs?.colspan ?? 1), rowSpan: Number(cell.attrs?.rowspan ?? 1),
            ...(cell.type === 'tableHeader' ? { shading: { fill: 'EEEEEE' } } : {}),
          });
        }),
      }));
      return [new Table({
        rows, columnWidths: resolvedWidths,
        width: resolvedWidths ? { size: resolvedWidths.reduce((sum, width) => sum + width, 0), type: WidthType.DXA } : { size: 100, type: WidthType.PERCENTAGE },
      })];
    }
    throw new DocxError('content', `Node editor tidak didukung untuk Word: ${node.type ?? '(missing)'}.`);
  });
  const children = blocks(content.content ?? [], { quoteDepth: 0, listDepth: 0 });
  return new Document({
    title, creator: 'Ruang Tulis', description: 'Dokumen diekspor dari editor lokal.',
    numbering: { config: numbering },
    styles: {
      paragraphStyles: [
        { id: 'EditorCodeBlock', name: 'EditorCodeBlock', basedOn: 'Normal', run: { font: 'Courier New' } },
        { id: 'EditorBlockquote', name: 'EditorBlockquote', basedOn: 'Normal' },
        { id: 'EditorHorizontalRule', name: 'EditorHorizontalRule', basedOn: 'Normal' },
      ],
      characterStyles: [{ id: 'EditorInlineCode', name: 'EditorInlineCode', basedOn: 'DefaultParagraphFont', run: { font: 'Courier New' } }],
    },
    sections: [{ children }],
  });
}

function assertXmlStrings(record: DocumentRecord): void {
  const pending: unknown[] = [record.title, record.content];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      // JSON Unicode validity is weaker than XML 1.0's Char production.
      if (/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) {
        throw new DocxError('content', 'Dokumen mengandung karakter yang tidak dapat disimpan dalam XML Word.');
      }
    } else if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
}

/**
 * Validates and snapshots a DocumentRecord before the first await. Produces a
 * genuine macro-free OOXML ZIP, never HTML renamed to .docx. Only embedded,
 * bounded, decoded local rasters are accepted; no network or filesystem access.
 * WebP is rasterized to PNG locally. No editor/store/record mutation or download
 * side effect occurs. Callers own confirmation, persistence and object-URL cleanup.
 */
export async function exportDocx(record: DocumentRecord): Promise<DocxExportResult> {
  let snapshot: DocumentRecord;
  try {
    snapshot = validateDocument(record);
    snapshot.content = checkedContent(snapshot.content);
    assertXmlStrings(snapshot);
  } catch (cause) { throw new DocxError('content', 'Dokumen tidak valid atau melebihi batas editor.', { cause }); }
  const warnings = [EXPORT_LIMITATION];
  let images: Map<string, ExportImage>;
  try { images = await prepareImages(snapshot.content, warnings); }
  catch (cause) { throw new DocxError('image', 'Gambar dokumen tidak dapat disiapkan dengan aman untuk Word.', { cause }); }
  try {
    const bytes = await Packer.toArrayBuffer(buildWord(snapshot.content, snapshot.title, images, warnings));
    if (bytes.byteLength > MAX_DOCX_BYTES) throw new Error('Export exceeds 12 MiB.');
    return { blob: new Blob([bytes], { type: DOCX_MIME }), filename: docxFilename(snapshot.title), warnings };
  } catch (cause) {
    if (cause instanceof DocxError) throw cause;
    throw new DocxError('conversion', 'Paket Word tidak dapat dibuat atau melebihi batas 12 MiB.', { cause });
  }
}
