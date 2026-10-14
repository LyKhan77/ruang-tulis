import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import mammoth from 'mammoth/mammoth.browser.js';
import {
  AlignmentType, Document, ExternalHyperlink, FootnoteReferenceRun, HeadingLevel, ImageRun, LevelFormat,
  Packer, Paragraph, Table, TableCell, TableRow, TextRun,
} from 'docx';
import { strFromU8, unzipSync } from 'fflate';
import { DOCX_MIME, MAX_DOCX_BYTES, docxFilename, exportDocx, importDocx } from './docx';
import { MAX_BACKUP_BYTES, validateContent } from './data';
import type { DocumentRecord } from './data';
import * as imagePreflight from './image-preflight';
import { pngDataUrl, rasterBytes, rasterFixture, TINY_PNG } from './raster-fixtures';

let decodedSources: string[];
let failDecode: boolean;

beforeEach(() => {
  decodedSources = [];
  failDecode = false;
  class LocalImage {
    naturalWidth = 1;
    naturalHeight = 1;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(source: string) {
      if (!source) return;
      decodedSources.push(source);
      queueMicrotask(() => failDecode ? this.onerror?.() : this.onload?.());
    }
  }
  vi.stubGlobal('Image', LocalImage);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function record(content: JSONContent, title = 'Dokumen 日本語 😀'): DocumentRecord {
  return {
    id: 'docx-test', title, content, schemaVersion: 1, revision: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function bytesOf(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
  return promise;
}

async function wordFile(children: (Paragraph | Table)[], name = 'Laporan.docx'): Promise<File> {
  const bytes = await Packer.toArrayBuffer(new Document({ sections: [{ children }] }));
  return new File([bytes], name, { type: DOCX_MIME });
}

function nodesOf(content: JSONContent): JSONContent[] {
  return [content, ...(content.content ?? []).flatMap(nodesOf)];
}

function tableGeometry(table: JSONContent) {
  return (table.content ?? []).map(row => (row.content ?? []).map(cell => [
    cell.type, Number(cell.attrs?.colspan ?? 1), Number(cell.attrs?.rowspan ?? 1),
    nodesOf(cell).filter(node => node.type === 'text').map(node => node.text).join(''),
  ]));
}

function wordTableGeometry(bytes: Uint8Array<ArrayBuffer>) {
  const xml = new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']), 'application/xml');
  const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return Array.from(xml.getElementsByTagNameNS(namespace, 'tr')).map(row => ({
    header: row.getElementsByTagNameNS(namespace, 'tblHeader').length > 0,
    cells: Array.from(row.getElementsByTagNameNS(namespace, 'tc')).map(cell => [
      cell.textContent,
      Number(cell.getElementsByTagNameNS(namespace, 'gridSpan')[0]?.getAttributeNS(namespace, 'val') ?? 1),
      cell.getElementsByTagNameNS(namespace, 'vMerge')[0]?.getAttributeNS(namespace, 'val') ?? null,
    ]),
  }));
}

const minimal: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Halo 世界 😀 العربية' }] }] };

describe('DOCX public contract', () => {
  it('exports a genuine Word ZIP with the correct MIME, filename, Unicode and plain limitation warnings', async () => {
    const original = record(minimal);
    const before = JSON.stringify(original);
    const result = await exportDocx(original);
    const bytes = await bytesOf(result.blob);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(result.blob.type).toBe(DOCX_MIME);
    expect(result.filename).toBe('Dokumen 日本語 😀.docx');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.every(message => typeof message === 'string')).toBe(true);
    const parts = unzipSync(bytes);
    expect(parts['[Content_Types].xml']).toBeDefined();
    expect(parts['_rels/.rels']).toBeDefined();
    expect(strFromU8(parts['word/document.xml'])).toContain('Halo 世界 😀 العربية');
    expect(strFromU8(parts['[Content_Types].xml'])).toContain('wordprocessingml.document.main+xml');
    expect(Object.keys(parts).some(name => /vba|activeX|embeddings/i.test(name))).toBe(false);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('imports independently generated real Word content and reads Files via the FileReader fallback', async () => {
    const file = await wordFile([
      new Paragraph({ heading: HeadingLevel.HEADING_2, alignment: AlignmentType.CENTER, indent: { left: 720 }, children: [new TextRun('Judul 日本語')] }),
      new Paragraph({ children: [
        new TextRun({ text: 'tebal', bold: true }), new TextRun({ text: 'miring', italics: true }),
        new TextRun({ text: 'garis', underline: {} }), new TextRun({ text: 'coret', strike: true }),
        new TextRun({ break: 1 }), new ExternalHyperlink({ link: 'https://example.com/日本語', children: [new TextRun('tautan')] }),
      ] }),
      new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('Sel 😀')] })] })] }),
    ], 'Laporan 日本語.docx');
    Object.defineProperty(file, 'arrayBuffer', { value: undefined });
    const imported = await importDocx(file);
    expect(imported.title).toBe('Laporan 日本語');
    expect(imported.content).toEqual(validateContent(imported.content));
    const nodes = nodesOf(imported.content);
    expect(nodes.some(node => node.type === 'heading' && node.attrs?.level === 2 && node.attrs?.textAlign === 'center' && node.attrs?.indent === 2)).toBe(true);
    expect(nodes.some(node => node.type === 'table')).toBe(true);
    expect(nodes.filter(node => node.type === 'text').map(node => node.text).join('')).toContain('Judul 日本語');
    const marks = nodes.flatMap(node => node.marks ?? []);
    for (const type of ['bold', 'italic', 'underline', 'strike', 'link']) expect(marks.some(mark => mark.type === type)).toBe(true);
    expect(marks.find(mark => mark.type === 'link')?.attrs).toMatchObject({ href: 'https://example.com/日本語', target: '_blank', rel: 'noopener noreferrer nofollow', class: null });
    expect(imported.warnings.every(message => typeof message === 'string')).toBe(true);
    expect(imported.warnings[0]).toMatch(/bukan salinan penuh/);
  });

  it('supports the File.arrayBuffer read path and rejects a changed byte length', async () => {
    const file = await wordFile([new Paragraph('ArrayBuffer')]);
    const bytes = await bytesOf(file);
    const read = vi.fn().mockResolvedValue(bytes.buffer);
    Object.defineProperty(file, 'arrayBuffer', { value: read, configurable: true });
    expect((await importDocx(file)).content).toMatchObject({ type: 'doc' });
    expect(read).toHaveBeenCalledOnce();
    read.mockResolvedValue(new ArrayBuffer(1));
    await expect(importDocx(file)).rejects.toMatchObject({ code: 'file' });
  });

  it.each([
    ['legacy.doc', DOCX_MIME, 'not a ZIP'], ['macro.docm', DOCX_MIME, 'not a ZIP'],
    ['wrong.docx', 'text/html', '<p>not Word</p>'], ['empty.docx', DOCX_MIME, ''],
  ])('rejects invalid file selection %s before conversion', async (name, type, value) => {
    await expect(importDocx(new File([value], name, { type }))).rejects.toMatchObject({ code: 'file' });
  });

  it('rejects renamed HTML, arbitrary ZIP bytes and oversized input without relying on extension/MIME', async () => {
    await expect(importDocx(new File(['<html>Word?</html>'], 'fake.docx'))).rejects.toMatchObject({ code: 'archive' });
    const file = new File(['x'], 'too-large.docx', { type: DOCX_MIME });
    Object.defineProperty(file, 'size', { value: MAX_DOCX_BYTES + 1 });
    await expect(importDocx(file)).rejects.toMatchObject({ code: 'file' });
    expect(decodedSources).toEqual([]);
  });

  it.each([
    ['../../bad:*/title.docx', '..-..-bad---title.docx'],
    ['CON', '_CON.docx'], ['nul.txt', '_nul.txt.docx'], ['', 'Dokumen.docx'],
    ['..', 'Dokumen.docx'], ['日本語 😀.docx.docx', '日本語 😀.docx'],
    ['Report.docx  ', 'Report.docx'], ['Report.docx..', 'Report.docx'],
    ['safe\u202e\u2066\u2069\u200e\u200f\u061c.docx', 'safe.docx'],
    ['Keluarga 👩‍👩‍👦.docx', 'Keluarga 👩‍👩‍👦.docx'],
  ])('creates a safe Unicode basename from %s', (title, filename) => {
    expect(docxFilename(title)).toBe(filename);
  });

  it('bounds imported titles and filenames without cutting Unicode surrogate pairs', async () => {
    const file = await wordFile([new Paragraph('x')], `${'😀'.repeat(120)}.docx`);
    const imported = await importDocx(file);
    expect(imported.title.length).toBe(200);
    expect(imported.title.endsWith('😀')).toBe(true);
    expect(docxFilename(imported.title).length).toBeLessThanOrEqual(125);
  });
});

describe('supported editor content and honest limitations', () => {
  it('exports headings, alignment, indentation, marks, breaks, code, quotes, rules, lists and table spans', async () => {
    const content: JSONContent = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 3, textAlign: 'right', indent: 2 }, content: [{ type: 'text', text: 'Heading 😀' }] },
      { type: 'paragraph', content: [
        { type: 'text', text: 'format', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'strike' }] },
        { type: 'hardBreak' }, { type: 'text', text: 'code', marks: [{ type: 'code' }] },
        { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'mailto:test@example.com' } }] },
      ] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kutipan' }] }] },
      { type: 'codeBlock', attrs: { language: 'typescript' }, content: [{ type: 'text', text: 'const x = 1;\n\t世界' }] },
      { type: 'horizontalRule' },
      { type: 'orderedList', attrs: { start: 7, type: 'A' }, content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item A' }] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Anak' }] }] }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item B' }] }] },
      ] },
      { type: 'table', content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2, rowspan: 1, colwidth: [100, 120] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Header' }] }] }] },
        { type: 'tableRow', content: [
          { type: 'tableCell', attrs: { rowspan: 2, align: 'center' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Merge' }] }] },
          { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
        ] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] }] },
      ] },
    ] };
    const exported = await exportDocx(record(content));
    const bytes = await bytesOf(exported.blob);
    const parts = unzipSync(bytes);
    const xml = strFromU8(parts['word/document.xml']);
    for (const fragment of ['Heading3', 'w:jc w:val="right"', 'w:left="720"', '<w:b', '<w:i', '<w:u', '<w:strike', '<w:br', '<w:tab', 'EditorInlineCode', 'EditorCodeBlock', 'EditorBlockquote', 'EditorHorizontalRule', 'w:gridSpan', 'w:vMerge']) expect(xml).toContain(fragment);
    const numbering = strFromU8(parts['word/numbering.xml']);
    expect(numbering).toContain('upperLetter');
    expect(numbering).toContain('w:start w:val="7"');
    expect(xml).toContain('w:gridCol w:w="1500"');
    expect(xml).toContain('w:gridCol w:w="1800"');
    expect(xml).toContain('w:jc w:val="center"');
    expect(wordTableGeometry(bytes)).toEqual([
      { header: true, cells: [['Header', 2, null]] },
      { header: false, cells: [['Merge', 1, 'restart'], ['A', 1, null]] },
      { header: false, cells: [['', 1, 'continue'], ['B', 1, null]] },
    ]);
    const imported = await importDocx(new File([bytes], 'Roundtrip.docx', { type: DOCX_MIME }));
    const nodes = nodesOf(imported.content);
    for (const type of ['heading', 'blockquote', 'codeBlock', 'horizontalRule', 'orderedList', 'bulletList', 'table']) expect(nodes.some(node => node.type === type)).toBe(true);
    expect(nodes.some(node => node.type === 'tableCell' && node.attrs?.rowspan === 2)).toBe(true);
    expect(tableGeometry(nodes.find(node => node.type === 'table')!)).toEqual(tableGeometry(content.content!.find(node => node.type === 'table')!));
    expect(nodes.filter(node => node.type === 'text').map(node => node.text).join('')).toContain('世界');
  });

  it('round-trips combined spans and simultaneous continuations at their actual grid columns', async () => {
    const cell = (text: string, colspan = 1, rowspan = 1, type = 'tableCell'): JSONContent => ({
      type, attrs: { colspan, rowspan }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const table: JSONContent = { type: 'table', content: [
      { type: 'tableRow', content: [cell('Header', 4, 1, 'tableHeader')] },
      { type: 'tableRow', content: [cell('Left', 1), cell('Middle', 2, 3), cell('Right')] },
      { type: 'tableRow', content: [cell('Left merge', 1, 2), cell('Right 2')] },
      { type: 'tableRow', content: [cell('Right 3')] },
    ] };
    const exported = await exportDocx(record({ type: 'doc', content: [table] }));
    const bytes = await bytesOf(exported.blob);
    expect(wordTableGeometry(bytes)).toEqual([
      { header: true, cells: [['Header', 4, null]] },
      { header: false, cells: [['Left', 1, null], ['Middle', 2, 'restart'], ['Right', 1, null]] },
      { header: false, cells: [['Left merge', 1, 'restart'], ['', 2, 'continue'], ['Right 2', 1, null]] },
      { header: false, cells: [['', 1, 'continue'], ['', 2, 'continue'], ['Right 3', 1, null]] },
    ]);
    const imported = await importDocx(new File([bytes], 'Merged.docx', { type: DOCX_MIME }));
    expect(tableGeometry(nodesOf(imported.content).find(node => node.type === 'table')!)).toEqual(tableGeometry(table));
  });

  it('imports actual Word lists while explicitly warning that starts/formats may change', async () => {
    const bytes = await Packer.toArrayBuffer(new Document({
      numbering: { config: [{ reference: 'custom', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', start: 5 }] }] },
      sections: [{ children: [new Paragraph({ numbering: { reference: 'custom', level: 0 }, children: [new TextRun('Lima')] })] }],
    }));
    const imported = await importDocx(new File([bytes], 'List.docx', { type: DOCX_MIME }));
    expect(nodesOf(imported.content).some(node => node.type === 'orderedList')).toBe(true);
    expect(imported.warnings.join(' ')).toMatch(/Penomoran dapat dimulai ulang/);
  });

  it('flattens unsupported high heading levels with a limitation warning', async () => {
    const result = await importDocx(await wordFile([new Paragraph({ heading: HeadingLevel.HEADING_6, text: 'Deep' })]));
    expect(nodesOf(result.content).find(node => node.type === 'heading')?.attrs?.level).toBe(3);
    expect(result.warnings.join(' ')).toMatch(/tingkat 3/);
  });

  it('reuses paragraph style rules rather than growing a quadratic lookup table', async () => {
    const file = await wordFile(Array.from({ length: 500 }, (_, index) => new Paragraph(`Paragraf ${index}`)));
    const convert = vi.spyOn(mammoth, 'convertToHtml');
    const imported = await importDocx(file);
    expect(imported.content.content).toHaveLength(500);
    const rules = convert.mock.calls[0][1]?.styleMap;
    expect(Array.isArray(rules)).toBe(true);
    expect((rules as string[]).filter(rule => rule.startsWith('p.EditorImport'))).toHaveLength(1);
  });

  it('omits unsupported note references before rendering repeated note bodies', async () => {
    const bytes = await Packer.toArrayBuffer(new Document({
      footnotes: { 1: { children: [new Paragraph('Unsupported footnote body')] } },
      sections: [{ children: [new Paragraph({ children: [new TextRun('Main body'), new FootnoteReferenceRun(1), new FootnoteReferenceRun(1)] })] }],
    }));
    const result = await importDocx(new File([bytes], 'Notes.docx', { type: DOCX_MIME }));
    expect(nodesOf(result.content).filter(node => node.type === 'text').map(node => node.text).join('')).toBe('Main body');
    expect(result.warnings.join(' ')).toMatch(/Catatan kaki, endnote, dan komentar tidak diimpor/);
  });

  it('emits one paragraph style, stable quote indentation and aligned list continuations', async () => {
    const original = record({ type: 'doc', content: [
      { type: 'blockquote', content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Quoted heading' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Quoted paragraph' }] },
      ] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Numbered' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Continuation' }] },
      ] }] },
    ] });
    const exported = await exportDocx(original);
    const bytes = await bytesOf(exported.blob);
    const xml = new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']), 'application/xml');
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    for (const properties of xml.getElementsByTagNameNS(namespace, 'pPr')) expect(properties.getElementsByTagNameNS(namespace, 'pStyle').length).toBeLessThanOrEqual(1);
    const continuation = Array.from(xml.getElementsByTagNameNS(namespace, 'p')).find(paragraph => paragraph.textContent === 'Continuation')!;
    expect(continuation.getElementsByTagNameNS(namespace, 'ind')[0].getAttributeNS(namespace, 'left')).toBe('720');
    const imported = await importDocx(new File([bytes], 'Quote.docx', { type: DOCX_MIME }));
    const quote = nodesOf(imported.content).find(node => node.type === 'paragraph' && node.content?.some(child => child.text === 'Quoted paragraph'))!;
    expect(quote.attrs?.indent ?? 0).toBe(0);
    const next = await exportDocx(record(imported.content));
    const nextXml = new DOMParser().parseFromString(strFromU8(unzipSync(await bytesOf(next.blob))['word/document.xml']), 'application/xml');
    const paragraph = Array.from(nextXml.getElementsByTagNameNS(namespace, 'p')).find(node => node.textContent === 'Quoted paragraph')!;
    expect(paragraph.getElementsByTagNameNS(namespace, 'ind')[0].getAttributeNS(namespace, 'left')).toBe('720');
  });

  it.each(['\ufffe', '\uffff'])('rejects JSON-valid characters forbidden by XML 1.0: %s', async character => {
    await expect(exportDocx(record({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `bad${character}` }] }] }))).rejects.toMatchObject({ code: 'content' });
    await expect(exportDocx(record(minimal, `bad${character}`))).rejects.toMatchObject({ code: 'content' });
    await expect(exportDocx(record({ type: 'doc', content: [{ type: 'image', attrs: { src: TINY_PNG, alt: `bad${character}` } }] }))).rejects.toMatchObject({ code: 'content' });
    expect(decodedSources).toEqual([]);
  });

  it('reserves editor metadata space even for content below the full data backup limit', async () => {
    const paragraph: JSONContent = { type: 'paragraph', attrs: { textAlign: null, indent: 0 }, content: [{ type: 'text', text: 'x' }] };
    const content: JSONContent = { type: 'doc', content: [
      ...Array.from({ length: 5000 }, () => ({ type: 'image', attrs: { src: TINY_PNG, alt: 'a'.repeat(2000), title: null, width: null, height: null } })),
      paragraph,
    ] };
    const remaining = MAX_BACKUP_BYTES - 4096 - new TextEncoder().encode(JSON.stringify(content)).byteLength;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(2 * 1024 * 1024 - 1);
    paragraph.content![0].text = 'x'.repeat(remaining + 1);
    expect(() => validateContent(content)).not.toThrow();
    await expect(exportDocx(record(content))).rejects.toMatchObject({ code: 'content' });
    expect(decodedSources).toEqual([]);
  });

  it('rejects invalid editor data instead of silently exporting a partial document', async () => {
    const bad: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unsafe', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] };
    await expect(exportDocx(record(bad))).rejects.toMatchObject({ code: 'content' });
    await expect(exportDocx(record({ type: 'doc', content: [{ type: 'unknown' }] }))).rejects.toMatchObject({ code: 'content' });
    await expect(exportDocx({ ...record(minimal), revision: -1 })).rejects.toMatchObject({ code: 'content' });
    expect(decodedSources).toEqual([]);
  });
});

describe('sanitization, local images and atomic conversion', () => {
  it('reconstructs only allowlisted JSON and never renders converter HTML or retains executable links', async () => {
    const file = await wordFile([new Paragraph('source')]);
    const append = vi.spyOn(document.body, 'appendChild');
    vi.spyOn(mammoth, 'convertToHtml').mockResolvedValue({ value: '<p onclick="alert(1)" style="background:url(https://evil.test/x)"><script>bad()</script><a href="javascript:alert(1)">unsafe</a> <a href="https://example.com" target="evil" class="evil" rel="opener">safe</a><svg onload="bad()"><text>SVG</text></svg><img src="https://evil.test/image.png"></p>', messages: [] });
    const imported = await importDocx(file);
    const json = JSON.stringify(imported.content);
    expect(json).toContain('unsafe');
    expect(json).toContain('safe');
    for (const fragment of ['javascript:', 'onclick', 'background:', 'bad()', 'opener"', 'evil.test', 'SVG']) expect(json).not.toContain(fragment);
    expect(nodesOf(imported.content).flatMap(node => node.marks ?? []).find(mark => mark.type === 'link')?.attrs).toEqual({ href: 'https://example.com', title: null, target: '_blank', rel: 'noopener noreferrer nofollow', class: null });
    expect(append).not.toHaveBeenCalled();
    expect(decodedSources).toEqual([]);
    expect(imported.warnings.length).toBeGreaterThan(1);
  });

  it.each(['block', 'inline'])('ignores complete SVG and MathML subtrees in %s content', async context => {
    const file = await wordFile([new Paragraph('source')]);
    const foreignContent = '<svg onload="bad()"><text>SVG text</text><foreignObject><p>SVG HTML <a href="https://evil.test">link</a><img src="' + TINY_PNG + '"></p></foreignObject></svg>'
      + '<math><mtext>Math text</mtext><annotation-xml encoding="text/html"><p>Math HTML <a href="https://evil.test">link</a><img src="' + TINY_PNG + '"></p></annotation-xml></math>';
    const value = context === 'inline' ? `<p>before${foreignContent}after</p>` : `<p>before</p>${foreignContent}<p>after</p>`;
    vi.spyOn(mammoth, 'convertToHtml').mockResolvedValue({ value, messages: [] });
    const append = vi.spyOn(document.body, 'appendChild');
    const imported = await importDocx(file);
    const nodes = nodesOf(imported.content);
    expect(nodes.filter(node => node.type === 'text').map(node => node.text).join('')).toBe('beforeafter');
    expect(nodes.some(node => node.type === 'image' || node.marks?.length)).toBe(false);
    for (const fragment of ['SVG', 'Math', 'evil.test', 'bad()']) expect(JSON.stringify(imported.content)).not.toContain(fragment);
    expect(append).not.toHaveBeenCalled();
    expect(decodedSources).toEqual([]);
    expect(imported.warnings.join(' ')).toContain('Elemen aktif atau format di luar skema editor diabaikan.');
  });

  it('rejects malformed sanitized table geometry and oversized content before returning', async () => {
    const file = await wordFile([new Paragraph('source')]);
    const convert = vi.spyOn(mammoth, 'convertToHtml');
    convert.mockResolvedValue({ value: '<table><tr><td rowspan="3">bad</td></tr></table>', messages: [] });
    await expect(importDocx(file)).rejects.toMatchObject({ code: 'content' });
    convert.mockResolvedValue({ value: `<p>${'x'.repeat(2 * 1024 * 1024 + 1)}</p>`, messages: [] });
    await expect(importDocx(file)).rejects.toMatchObject({ code: 'content' });
  });

  it('preserves literal XML/HTML-looking text as text rather than interpreting it', async () => {
    const literal = '<script>alert("x")</script> & <b>not markup</b>';
    const result = await importDocx(await wordFile([new Paragraph(literal)]));
    expect(nodesOf(result.content).filter(node => node.type === 'text').map(node => node.text).join('')).toBe(literal);
  });

  it('embeds safe local PNG bytes and alt text and decodes each distinct image once', async () => {
    const source = record({ type: 'doc', content: [
      { type: 'image', attrs: { src: TINY_PNG, alt: '日本語 😀', title: 'Titre', width: 80, height: 40 } },
      { type: 'image', attrs: { src: TINY_PNG } },
    ] });
    const exported = await exportDocx(source);
    expect(decodedSources).toEqual([TINY_PNG]);
    const bytes = await bytesOf(exported.blob);
    const parts = unzipSync(bytes);
    const media = Object.entries(parts).filter(([name]) => name.startsWith('word/media/') && name.endsWith('.png'));
    expect(media).toHaveLength(1);
    expect(media[0][1]).toEqual(rasterBytes('png'));
    expect(strFromU8(parts['word/document.xml'])).toContain('日本語 😀');
    decodedSources = [];
    const imported = await importDocx(new File([bytes], 'Gambar.docx', { type: DOCX_MIME }));
    expect(nodesOf(imported.content).filter(node => node.type === 'image')).toHaveLength(2);
    expect(decodedSources).toEqual([TINY_PNG]);
  });

  it('bounds repeated embedded-image expansion before building converter HTML', async () => {
    const source = pngDataUrl({ byteLength: 2 * 1024 * 1024 });
    const data = Uint8Array.from(atob(source.split(',')[1]), character => character.charCodeAt(0));
    const file = await wordFile(Array.from({ length: 7 }, () => new Paragraph({
      children: [new ImageRun({ type: 'png', data, transformation: { width: 1, height: 1 } })],
    })));
    await expect(importDocx(file)).rejects.toMatchObject({ code: 'conversion' });
    expect(decodedSources).toEqual([]);
  });

  it('requires the real browser raster decode check before importing embedded Word images', async () => {
    const file = await wordFile([new Paragraph({ children: [new ImageRun({ type: 'png', data: rasterBytes('png'), transformation: { width: 1, height: 1 } })] })]);
    failDecode = true;
    await expect(importDocx(file)).rejects.toMatchObject({ code: 'image' });
    expect(decodedSources).toEqual([TINY_PNG]);
  });

  it('rejects unsafe local-image sources and decoder failures during export', async () => {
    await expect(exportDocx(record({ type: 'doc', content: [{ type: 'image', attrs: { src: 'https://example.com/image.png' } }] }))).rejects.toMatchObject({ code: 'content' });
    failDecode = true;
    await expect(exportDocx(record({ type: 'doc', content: [{ type: 'image', attrs: { src: TINY_PNG } }] }))).rejects.toMatchObject({ code: 'image' });
  });

  it('converts safe WebP locally to PNG rather than mislabeling its original bytes', async () => {
    const draw = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(TINY_PNG);
    const exported = await exportDocx(record({ type: 'doc', content: [{ type: 'image', attrs: { src: rasterFixture('webp') } }] }));
    const parts = unzipSync(await bytesOf(exported.blob));
    const media = Object.entries(parts).find(([name]) => name.startsWith('word/media/') && name.endsWith('.png'));
    expect(media?.[1]).toEqual(rasterBytes('png'));
    expect(draw).toHaveBeenCalledOnce();
    expect(exported.warnings.join(' ')).toMatch(/WebP dikonversi ke PNG/);
  });

  it('snapshots the validated record before asynchronous image processing', async () => {
    const gate = Promise.withResolvers<void>();
    vi.spyOn(imagePreflight, 'decodeLocalRaster').mockReturnValue(gate.promise);
    const original = record({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'sebelum' }] },
      { type: 'image', attrs: { src: TINY_PNG } },
    ] }, 'Sebelum');
    const pending = exportDocx(original);
    original.title = 'Sesudah';
    original.content.content![0].content![0].text = 'sesudah';
    original.content.content![1].attrs!.src = 'https://unsafe.test/x';
    gate.resolve();
    const result = await pending;
    expect(result.filename).toBe('Sebelum.docx');
    const xml = strFromU8(unzipSync(await bytesOf(result.blob))['word/document.xml']);
    expect(xml).toContain('sebelum');
    expect(xml).not.toContain('sesudah');
    expect(xml).not.toContain('unsafe.test');
  });
});
