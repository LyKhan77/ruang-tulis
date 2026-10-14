// @vitest-environment node
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSchema, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import {
  ConflictError,
  DocumentStore,
  MAX_BACKUP_BYTES,
  MAX_IMAGE_BYTES,
  MissingDocumentError,
  createDocumentId,
  emptyContent,
  isSafeImage,
  inspectRaster,
  isSafeLink,
  parseBackup,
  sampleContent,
  serializeBackup,
  validateContent,
  validateDocument,
  type DocumentRecord,
} from './data';
import {
  TINY_PNG, paddedPng, pngCrc, pngDataUrl, rasterBytes, rasterDataUrl, rasterFixture,
  type RasterFormat,
} from './raster-fixtures';

const timestamp = '2026-01-01T00:00:00.000Z';
const png = TINY_PNG;
const textNode = (text = 'Halo'): JSONContent => ({ type: 'text', text });
const paragraph = (text = 'Halo'): JSONContent => ({
  type: 'paragraph', content: [textNode(text)],
});
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const record = (id = 'original', content = doc(paragraph())): DocumentRecord => ({
  id, title: 'Catatan', content, schemaVersion: 1,
  createdAt: timestamp, updatedAt: timestamp, revision: 0,
});
const envelope = (documents: unknown[], extra: object = {}) => JSON.stringify({
  format: 'document-editor', version: 1, documents, ...extra,
});
const cell = (attrs?: object): JSONContent => ({
  type: 'tableCell', ...(attrs ? { attrs } : {}), content: [paragraph()],
});
const row = (...content: JSONContent[]): JSONContent => ({ type: 'tableRow', content });
const table = (...content: JSONContent[]): JSONContent => ({ type: 'table', content });

let factory: IDBFactory;
let stores: DocumentStore[];
let databaseNames: Set<string>;
let sequence = 0;
function store(name = `data-test-${++sequence}`): DocumentStore {
  databaseNames.add(name);
  const instance = new DocumentStore(name);
  stores.push(instance);
  return instance;
}

beforeEach(() => {
  factory = new IDBFactory();
  stores = [];
  databaseNames = new Set();
  vi.stubGlobal('indexedDB', factory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.map(instance => instance.close().catch(() => undefined)));
  for (const name of databaseNames) {
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  vi.unstubAllGlobals();
});

describe('content and record validation', () => {
  it('returns independent, valid empty and Indonesian sample documents', () => {
    expect(emptyContent()).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    const first = emptyContent();
    first.content!.push(paragraph('Modified'));
    expect(emptyContent().content).toHaveLength(1);
    const sample = sampleContent();
    expect(validateContent(sample)).toEqual(sample);
    expect(JSON.stringify(sample)).toMatch(/Selamat datang|dokumen|Catatan/);
  });

  it('roundtrips every supported block, attribute and mark without mutating input', () => {
    const content = doc(
      { type: 'heading', attrs: { level: 3, textAlign: 'center', indent: 8 }, content: [textNode('Judul')] },
      { type: 'paragraph', attrs: { textAlign: 'justify', indent: 0 }, content: [
        ...['bold', 'italic', 'underline', 'strike', 'code'].map(type => ({ ...textNode(type), marks: [{ type }] })),
        { ...textNode('tautan'), marks: [{ type: 'link', attrs: {
          href: 'https://example.com', title: null, target: '_blank', rel: 'noopener noreferrer nofollow', class: null,
        } }] },
        { type: 'hardBreak' },
      ] },
      { type: 'paragraph', attrs: { textAlign: null, indent: 0 } },
      { type: 'heading', attrs: { level: 2, textAlign: null, indent: 0 }, content: [textNode('Subjudul')] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph()] }] },
      { type: 'orderedList', attrs: { start: 2, type: null }, content: [{ type: 'listItem', content: [paragraph()] }] },
      { type: 'blockquote', content: [paragraph()] },
      { type: 'codeBlock', attrs: { language: 'typescript' }, content: [textNode('const x = 1;')] },
      { type: 'codeBlock', attrs: { language: null } },
      { type: 'horizontalRule' },
      { type: 'image', attrs: { src: png, alt: 'Gambar', title: null, width: null, height: null } },
      table(row({ type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: [120], align: 'center' }, content: [paragraph()] }, cell({ align: null })), row(cell({ align: 'left' }), cell({ align: 'right' }))),
    );
    const output = validateContent(content);
    expect(output).toEqual(content);
    expect(output).not.toBe(content);
    output.content![0].attrs!.level = 1;
    expect(content.content![0].attrs!.level).toBe(3);
  });

  it('supports rectangular tables with row and column spans', () => {
    const content = doc(table(
      row(cell({ colspan: 1, rowspan: 2, colwidth: null }), cell({ colspan: 2, rowspan: 1, colwidth: [100, 0] })),
      row(cell(), cell()),
    ));
    expect(validateContent(content)).toEqual(content);
    const fullySpanned = doc(table(row(cell({ colspan: 2, rowspan: 2 })), row()));
    expect(validateContent(fullySpanned)).toEqual(fullySpanned);
  });

  it('accepts emitted ordered-list styles and normalizes pasted image dimensions', () => {
    for (const type of ['1', 'a', 'A', 'i', 'I']) {
      const content = doc({ type: 'orderedList', attrs: { start: 1, type }, content: [{ type: 'listItem', content: [paragraph()] }] });
      expect(validateContent(content)).toEqual(content);
    }
    expect(validateContent(doc({ type: 'image', attrs: { src: png, width: '640', height: '480px' } }))).toEqual(
      doc({ type: 'image', attrs: { src: png, width: 640, height: 480 } }),
    );
    expect(() => validateContent(doc({ type: 'image', attrs: { src: png, width: 10_000, height: 0.5 } }))).not.toThrow();
  });

  it('accepts real Tiptap schema serialization defaults without importing the UI', () => {
    const schema = getSchema([
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Image.configure({ allowBase64: true }),
      Table, TableRow, TableHeader, TableCell,
      TextAlign.configure({ types: ['paragraph', 'heading'] }),
    ]);
    const emitted = schema.nodeFromJSON(doc(
      { type: 'heading', attrs: { level: 1 }, content: [textNode('Heading')] },
      { type: 'paragraph', content: [{ ...textNode('Link'), marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
      { type: 'orderedList', content: [{ type: 'listItem', content: [paragraph()] }] },
      { type: 'codeBlock', content: [textNode('hello')] },
      { type: 'image', attrs: { src: png } },
      table(row({ type: 'tableHeader', content: [paragraph()] }, cell()), row(cell(), cell())),
    )).toJSON();
    expect(validateContent(emitted)).toEqual(emitted);
    expect(() => schema.nodeFromJSON(validateContent(emitted)).check()).not.toThrow();
  });

  it.each([
    null, [], {}, { type: 'doc' }, doc(), doc(textNode()), doc({ type: 'script' }),
    doc({ type: 'paragraph', content: [paragraph()] }),
    doc({ type: 'heading', attrs: { level: 4 }, content: [textNode()] }),
    doc({ type: 'heading', attrs: { level: 1.5 } }),
    doc({ type: 'paragraph', attrs: { indent: -1 } }),
    doc({ type: 'paragraph', attrs: { indent: 9 } }),
    doc({ type: 'paragraph', attrs: { indent: 1.2 } }),
    doc({ type: 'paragraph', attrs: { textAlign: 'evil' } }),
    doc({ type: 'paragraph', attrs: { onclick: 'alert(1)' } }),
    doc({ type: 'paragraph', attrs: { style: 'background:url(javascript:alert(1))' } }),
    doc({ type: 'paragraph', attrs: { id: 'unexpected' } }),
    doc({ type: 'paragraph', text: 'not a text node' }),
    doc({ type: 'paragraph', content: [{ type: 'text', text: '' }] }),
    doc({ type: 'paragraph', content: [{ type: 'text', text: 12 } as unknown as JSONContent] }),
    doc({ type: 'paragraph', content: [{ type: 'text', text: 'ok', attrs: { color: 'red' } }] }),
    doc({ type: 'paragraph', content: [{ ...textNode(), marks: [{ type: 'script' }] }] }),
    doc({ type: 'paragraph', content: [{ ...textNode(), marks: [{ type: 'bold', attrs: { onclick: 'x' } }] }] }),
    doc({ type: 'paragraph', content: [{ ...textNode(), marks: [{ type: 'bold' }, { type: 'bold' }] }] }),
    doc({ type: 'paragraph', content: [{ ...textNode(), marks: [{ type: 'code' }, { type: 'bold' }] }] }),
    doc({ type: 'paragraph', content: [{ ...textNode(), marks: [{ type: 'link', attrs: { href: null } }] }] }),
    doc({ type: 'paragraph', content: [{ ...textNode(), marks: [{ type: '__proto__' }] }] }),
    doc({ type: 'paragraph', content: [{ ...textNode(), marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }),
    doc({ type: 'paragraph', content: [{ ...textNode(), marks: [{ type: 'link', attrs: { href: 'https://example.com', onclick: 'x' } }] }] }),
    doc({ type: 'paragraph', content: [{ ...textNode(), marks: [{ type: 'link', attrs: { href: 'https://example.com', target: 'arbitrary-window' } }] }] }),
    doc({ type: 'paragraph', content: [{ ...textNode(), marks: [{ type: 'link', attrs: { href: 'https://example.com', rel: 'opener' } }] }] }),
    doc({ type: 'paragraph', content: [{ ...textNode(), marks: [{ type: 'link', attrs: { href: 'https://example.com', class: 'unexpected' } }] }] }),
    doc({ type: 'orderedList', attrs: { start: 0 }, content: [{ type: 'listItem', content: [paragraph()] }] }),
    doc({ type: 'orderedList', attrs: { type: 'unexpected' }, content: [{ type: 'listItem', content: [paragraph()] }] }),
    doc({ type: 'bulletList', content: [paragraph()] }),
    doc({ type: 'listItem', content: [paragraph()] }),
    doc({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'heading', attrs: { level: 1 } }] }] }),
    doc({ type: 'blockquote', content: [] }),
    doc({ type: 'codeBlock', content: [{ type: 'hardBreak' }] }),
    doc({ type: 'codeBlock', content: [{ ...textNode(), marks: [{ type: 'bold' }] }] }),
    doc({ type: 'hardBreak' }),
    doc({ type: 'horizontalRule', content: [paragraph()] }),
    doc({ type: 'image', attrs: { src: 'https://example.com/a.png' } }),
    doc({ type: 'image', attrs: { src: png, onerror: 'alert(1)' } }),
    ...[-1, 0, 10_001, Infinity, NaN, '100%', 'auto', 'expression(alert(1))', ' 100', '1e300', {}].map(width =>
      doc({ type: 'image', attrs: { src: png, width } })),
    doc(table()), doc(table(row())), doc(table(row(paragraph()))),
    doc(table(row(cell(), cell()), row(cell()))),
    doc(table(row(cell({ colspan: 1, rowspan: 2 })))),
    doc(table(row(cell({ colspan: 0 })))),
    doc(table(row(cell({ rowspan: -1 })))),
    doc(table(row(cell({ colspan: 2, colwidth: [100] })))),
    doc(table(row(cell({ colwidth: [-1] })))),
    doc(table(row(cell({ align: 'justify' })))),
    doc(table(row(cell({ align: 'expression(alert(1))' })))),
    doc(table(row({ type: 'tableCell', content: [] }))),
    { type: 'doc', content: [paragraph()], attrs: { schemaVersion: 2 } },
    { type: 'doc', content: [paragraph()], unexpected: true },
  ])('rejects malformed or unsupported content %#', input => {
    expect(() => validateContent(input)).toThrow();
  });

  it('rejects cycles, sparse arrays, accessors, non-JSON values and unpaired surrogates', () => {
    const cyclic: JSONContent = { type: 'blockquote', content: [] };
    cyclic.content!.push(cyclic);
    const accessor = Object.defineProperty({ type: 'paragraph' }, 'attrs', {
      enumerable: true, get: () => { throw new Error('Accessor must not execute'); },
    });
    const sparse = { type: 'doc', content: Array(1) };
    for (const value of [doc(cyclic), doc(accessor), sparse, doc(paragraph('\ud800')), doc({ type: 'paragraph', attrs: { indent: undefined } })]) {
      expect(() => validateContent(value)).toThrow();
    }
    expect(() => validateContent(doc(paragraph('😀')))).not.toThrow();
  });

  it('enforces depth, node, text-byte and attribute-length limits', () => {
    let boundary: JSONContent = paragraph();
    for (let i = 0; i < 21; i++) boundary = { type: 'blockquote', content: [boundary] };
    expect(() => validateContent(doc(boundary))).not.toThrow();
    expect(() => validateContent(doc(...Array.from({ length: 29_999 }, () => ({ type: 'paragraph' }))))).not.toThrow();
    let nested: JSONContent = paragraph();
    for (let i = 0; i < 24; i++) nested = { type: 'blockquote', content: [nested] };
    expect(() => validateContent(doc(nested))).toThrow();
    expect(() => validateContent(doc(...Array.from({ length: 30_000 }, () => ({ type: 'paragraph' }))))).toThrow();
    expect(() => validateContent(doc(paragraph('a'.repeat(2 * 1024 * 1024))))).not.toThrow();
    expect(() => validateContent(doc(paragraph('a'.repeat(2 * 1024 * 1024 + 1))))).toThrow();
    expect(() => validateContent(doc(paragraph('é'.repeat(1024 * 1024 + 1))))).toThrow();
    expect(() => validateContent(doc({ type: 'image', attrs: { src: png, alt: 'x'.repeat(MAX_BACKUP_BYTES + 1) } }))).toThrow();
  });

  it('validates document metadata strictly and returns an independent snapshot', () => {
    expect(validateDocument(record())).toEqual(record());
    expect(() => validateDocument({ ...record(), title: 'x'.repeat(200) })).not.toThrow();
    for (const patch of [
      { id: '' }, { id: 'x'.repeat(201) }, { title: 'x'.repeat(201) }, { title: 2 },
      { schemaVersion: 2 }, { schemaVersion: undefined }, { revision: -1 }, { revision: 0.5 },
      { revision: Number.MAX_SAFE_INTEGER + 1 }, { createdAt: 'not a date' },
      { createdAt: '2026-02-30T00:00:00.000Z' }, { updatedAt: '2025-01-01T00:00:00.000Z' },
      { extra: true }, { content: doc({ type: 'script' }) },
    ]) expect(() => validateDocument({ ...record(), ...patch })).toThrow();
    const original = record();
    validateDocument(original).content.content!.push(paragraph('copy'));
    expect(original.content.content).toHaveLength(1);
  });
});

describe('safe links and bounded embedded images', () => {
  it.each([
    'https://example.com/path?q=1#part', 'http://localhost:5173/',
    'mailto:hello@example.com', 'HTTPS://example.com/',
  ])('allows safe link %s', value => expect(isSafeLink(value)).toBe(true));

  it.each([
    '', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=',
    'tel:+628123456789', '#heading', '/notes', './notes', '../notes', '?page=2', 'notes',
    'mailto:', 'mailto:hello@example.com?subject=test%0d%0aBcc:evil@example.com',
    'vbscript:msgbox(1)', 'file:///etc/passwd', '//evil.example', '\\evil.example',
    '/\\evil.example', ' https://example.com', 'java\nscript:alert(1)',
    'https://example.com\u0000', 'https://', 'https://user:password@example.com', 'ftp://example.com',
    'javascript&#58;alert(1)', 'https://example.com/' + 'x'.repeat(2048),
  ])('rejects unsafe link %s', value => expect(isSafeLink(value)).toBe(false));

  it.each<RasterFormat>(['png', 'jpeg', 'gif', 'webp'])('allows genuine small %s rasters without a DOM', format => {
    const value = rasterFixture(format);
    expect(isSafeImage(value)).toBe(true);
    expect(inspectRaster(value)).toEqual({ width: 1, height: 1, bytes: rasterBytes(format).length });
    expect(() => validateContent(doc({ type: 'image', attrs: { src: value } }))).not.toThrow();
    expect(parseBackup(serializeBackup([record('raster', doc({ type: 'image', attrs: { src: value } }))]))).toHaveLength(1);
  });

  it.each<RasterFormat>(['png', 'jpeg', 'gif', 'webp'])('rejects fake, mismatched and truncated %s content', format => {
    const source = rasterBytes(format);
    const other: RasterFormat = format === 'png' ? 'gif' : 'png';
    const malformed = [
      `data:image/${format};base64,AAAA`,
      rasterDataUrl(format, rasterBytes(other)),
      rasterDataUrl(format, source.subarray(0, 8)),
      rasterDataUrl(format, source.subarray(0, source.length - 1)),
      rasterDataUrl(format, new Uint8Array([...source, 0])),
    ];
    for (const value of malformed) {
      expect(isSafeImage(value)).toBe(false);
      expect(inspectRaster(value)).toBeUndefined();
      expect(() => validateContent(doc({ type: 'image', attrs: { src: value } }))).toThrow('unsafe or oversized image');
      expect(() => parseBackup(envelope([record('bad', doc({ type: 'image', attrs: { src: value } }))]))).toThrow();
    }
  });

  it('requires canonical base64 for genuine image bytes', () => {
    const value = rasterFixture('gif');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const index = value.length - 3;
    const noncanonical = value.slice(0, index) + alphabet[alphabet.indexOf(value[index]) | 1] + value.slice(index + 1);
    expect(isSafeImage(value)).toBe(true);
    for (const malformed of [noncanonical, value + '\n', value.replace('base64,', 'base64, '), value.slice(0, -1)]) {
      expect(isSafeImage(malformed)).toBe(false);
    }
  });

  it('fails closed when the bounded base64 decoder is unavailable or throws', () => {
    vi.stubGlobal('atob', undefined);
    expect(isSafeImage(png)).toBe(false);
    vi.stubGlobal('atob', () => { throw new Error('Invalid base64'); });
    expect(isSafeImage(png)).toBe(false);
  });

  it('allows a genuine GIF89a with graphic control extension and local image data', () => {
    const value = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    expect(isSafeImage(value)).toBe(true);
    expect(inspectRaster(value)).toMatchObject({ width: 1, height: 1 });
  });

  it('allows a valid bounded GIF with more than 4096 image-data sub-blocks', () => {
    const pixels = 1024 * 1024;
    const clearEvery = 200;
    const codes = pixels + Math.ceil(pixels / clearEvery) + 1;
    const compressed = new Uint8Array(Math.ceil(codes * 9 / 8));
    let accumulator = 0;
    let bits = 0;
    let position = 0;
    const emit = (code: number) => {
      accumulator |= code << bits;
      bits += 9;
      while (bits >= 8) {
        compressed[position++] = accumulator & 255;
        accumulator >>>= 8;
        bits -= 8;
      }
    };
    // Frequent clear codes keep the LZW dictionary below the 10-bit threshold.
    for (let pixel = 0; pixel < pixels; pixel++) {
      if (pixel % clearEvery === 0) emit(256);
      emit(pixel & 255);
    }
    emit(257);
    if (bits) compressed[position++] = accumulator & 255;
    expect(position).toBe(compressed.length);
    const subBlockCount = Math.ceil(compressed.length / 255);
    const bytes = new Uint8Array(13 + 768 + 10 + 1 + compressed.length + subBlockCount + 2);
    bytes.set([71, 73, 70, 56, 55, 97, 0, 4, 0, 4, 0xf7, 0, 0]);
    for (let color = 0; color < 256; color++) bytes.fill(color, 13 + color * 3, 16 + color * 3);
    let offset = 13 + 768;
    bytes.set([0x2c, 0, 0, 0, 0, 0, 4, 0, 4, 0], offset);
    offset += 10;
    bytes[offset++] = 8;
    for (let start = 0; start < compressed.length; start += 255) {
      const block = compressed.subarray(start, start + 255);
      bytes[offset++] = block.length;
      bytes.set(block, offset);
      offset += block.length;
    }
    bytes[offset++] = 0;
    bytes[offset] = 0x3b;
    expect(subBlockCount).toBeGreaterThan(4096);
    expect(bytes.length).toBeLessThan(MAX_IMAGE_BYTES);
    const value = rasterDataUrl('gif', bytes);
    expect(isSafeImage(value)).toBe(true);
    expect(inspectRaster(value)).toEqual({ width: 1024, height: 1024, bytes: bytes.length });
  });

  it.each([
    '', 'https://example.com/image.png', 'blob:https://example.com/id',
    'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpg;base64,AAAA',
    'data:text/html;base64,AAAA', 'data:image/png,hello',
    'data:image/png;base64,', 'data:image/png;base64,AA',
    'data:image/png;base64,@@==', 'data:image/png;base64,A===',
    'data:image/png;base64,AA==AAAA', 'data:image/png;base64,AAAA\n',
    'data:image/png;base64,AB==', 'data:image/png;base64,iVBORw0KGgo=',
  ])('rejects unsafe or malformed image %s', value => expect(isSafeImage(value)).toBe(false));

  it('bounds decoded image bytes using genuine CRC-correct padded PNGs', () => {
    for (const bytes of [MAX_IMAGE_BYTES - 2, MAX_IMAGE_BYTES - 1, MAX_IMAGE_BYTES]) {
      const value = paddedPng(bytes);
      expect(isSafeImage(value)).toBe(true);
      expect(inspectRaster(value)).toEqual({ width: 1, height: 1, bytes });
      expect(() => validateContent(doc({ type: 'image', attrs: { src: value } }))).not.toThrow();
    }
    const overLimit = paddedPng(MAX_IMAGE_BYTES + 1);
    const decode = vi.spyOn(globalThis, 'atob');
    expect(isSafeImage(overLimit)).toBe(false);
    expect(decode).not.toHaveBeenCalled();
    expect(() => validateContent(doc({ type: 'image', attrs: { src: overLimit } }))).toThrow();
  });

  it('provides exact-sized genuine PNG padding with a stable fixture interface', () => {
    const minimum = rasterBytes('png').length;
    expect(pngDataUrl()).toBe(TINY_PNG);
    expect(paddedPng(minimum)).toBe(TINY_PNG);
    for (const bytes of [minimum + 12, minimum + 13, minimum + 14, 1024]) {
      expect(inspectRaster(paddedPng(bytes))?.bytes).toBe(bytes);
    }
    for (const bytes of [-1, minimum - 1, minimum + 1, minimum + 11, NaN, 100.5]) {
      expect(() => paddedPng(bytes)).toThrow(RangeError);
    }
  });

  it.each<RasterFormat>(['png', 'jpeg', 'gif', 'webp'])('bounds intrinsic %s dimensions independently of display attributes', format => {
    const dimensions = (width: number, height: number): string => {
      if (format === 'png') return pngDataUrl({ width, height });
      const bytes = rasterBytes(format);
      const view = new DataView(bytes.buffer);
      if (format === 'gif') {
        view.setUint16(6, width, true);
        view.setUint16(8, height, true);
      } else if (format === 'jpeg') {
        const sof = bytes.findIndex((byte, index) => byte === 0xff && bytes[index + 1] === 0xc0);
        view.setUint16(sof + 5, height);
        view.setUint16(sof + 7, width);
      } else {
        const packed = ((width - 1) | ((height - 1) << 14)) >>> 0;
        view.setUint32(21, packed, true);
      }
      return rasterDataUrl(format, bytes);
    };
    expect(isSafeImage(dimensions(10_000, 4_000))).toBe(true);
    const invalid = [[10_001, 1], [1, 10_001], [10_000, 4_001], [6_325, 6_325]];
    if (format !== 'webp') invalid.push([0, 1], [1, 0]);
    for (const [width, height] of invalid) {
      const value = dimensions(width, height);
      expect(isSafeImage(value)).toBe(false);
      expect(() => validateContent(doc({ type: 'image', attrs: { src: value, width: 1, height: 1 } }))).toThrow();
    }
  });

  it('rejects malformed PNG IHDR, chunk bounds, CRC, palette and missing image data', () => {
    const corrupt = (mutate: (bytes: Uint8Array, view: DataView) => void): string => {
      const bytes = rasterBytes('png');
      mutate(bytes, new DataView(bytes.buffer));
      return rasterDataUrl('png', bytes);
    };
    const header = (offset: number, value: number): string => corrupt((bytes, view) => {
      bytes[offset] = value;
      view.setUint32(29, pngCrc(bytes.subarray(12, 29)));
    });
    const withoutData = rasterBytes('png');
    const malformed = [
      corrupt((bytes) => { bytes[0] = 0; }),
      corrupt((_, view) => { view.setUint32(8, 12); }),
      corrupt((_, view) => { view.setUint32(33, 0xffffffff); }),
      corrupt((bytes) => { bytes[29] ^= 1; }),
      corrupt((bytes) => { bytes[45] ^= 1; }),
      corrupt((bytes, view) => { bytes[41] = 0; view.setUint32(53, pngCrc(bytes.subarray(37, 53))); }),
      header(24, 3), header(25, 1), header(26, 1), header(27, 1), header(28, 2),
      header(25, 3), // Indexed PNG requires PLTE before IDAT.
      rasterDataUrl('png', new Uint8Array([...withoutData.subarray(0, 33), ...withoutData.subarray(-12)])),
    ];
    for (const value of malformed) expect(isSafeImage(value)).toBe(false);
  });

  it('rejects malformed GIF image descriptors, color tables, LZW headers and sub-block bounds', () => {
    const mutate = (change: (bytes: Uint8Array, descriptor: number) => void): string => {
      const bytes = rasterBytes('gif');
      const descriptor = bytes.indexOf(0x2c, 13 + 12);
      change(bytes, descriptor);
      return rasterDataUrl('gif', bytes);
    };
    const malformed = [
      mutate(bytes => { bytes[4] = 0; }),
      mutate(bytes => { bytes[10] = 0x87; }), // Claims a missing 256-entry palette.
      mutate((bytes, start) => { bytes[start + 5] = 0; bytes[start + 6] = 0; }),
      mutate((bytes, start) => { bytes[start + 1] = 1; }), // Frame exceeds logical screen.
      mutate((bytes, start) => { bytes[start + 9] |= 0x18; }),
      mutate((bytes, start) => { bytes[start + 10] = 1; }),
      mutate((bytes, start) => { bytes[start + 11] = 0xff; }),
      mutate((bytes, start) => { bytes[start + 11] = 0; }),
    ];
    for (const value of malformed) expect(isSafeImage(value)).toBe(false);
  });

  it('rejects malformed JPEG segments, SOF/SOS headers and missing entropy/EOI', () => {
    const mutate = (change: (bytes: Uint8Array, sof: number, sos: number) => void): string => {
      const bytes = rasterBytes('jpeg');
      const sof = bytes.findIndex((byte, index) => byte === 0xff && bytes[index + 1] === 0xc0);
      const sos = bytes.findIndex((byte, index) => byte === 0xff && bytes[index + 1] === 0xda);
      change(bytes, sof, sos);
      return rasterDataUrl('jpeg', bytes);
    };
    const source = rasterBytes('jpeg');
    const sos = source.findIndex((byte, index) => byte === 0xff && source[index + 1] === 0xda);
    const scanStart = sos + 2 + new DataView(source.buffer).getUint16(sos + 2);
    const malformed = [
      mutate(bytes => { bytes[1] = 0; }),
      mutate(bytes => { bytes[4] = 0xff; bytes[5] = 0xff; }),
      mutate(bytes => {
        const dqt = bytes.findIndex((byte, index) => byte === 0xff && bytes[index + 1] === 0xdb);
        bytes[dqt + 4] = 0xff;
      }),
      mutate(bytes => {
        const dht = bytes.findIndex((byte, index) => byte === 0xff && bytes[index + 1] === 0xc4);
        bytes[dht + 5] = 0xff;
      }),
      mutate((bytes, sof) => { bytes[sof + 3] = 2; }),
      mutate((bytes, sof) => { bytes[sof + 4] = 0; }),
      mutate((bytes, sof) => { bytes[sof + 9] = 0; }),
      mutate((bytes, _, start) => { bytes[start + 4] = 0; }),
      mutate((bytes, _, start) => { bytes[start + 5] = 99; }),
      rasterDataUrl('jpeg', new Uint8Array([...source.subarray(0, scanStart), 0xff, 0xd9])),
      rasterDataUrl('jpeg', source.subarray(0, sos)),
    ];
    for (const value of malformed) expect(isSafeImage(value)).toBe(false);
  });

  it('inspects genuine lossy VP8, lossless VP8L and extended VP8X WebP headers', () => {
    const lossy = 'data:image/webp;base64,UklGRjgAAABXRUJQVlA4ICwAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8Por/zNExzH7V//lKvBY3N8AAA==';
    expect(inspectRaster(lossy)).toEqual({ width: 1, height: 1, bytes: 64 });
    const extended = (width: number, height: number): Uint8Array => {
      const source = rasterBytes('webp');
      const bytes = new Uint8Array(source.length + 18);
      bytes.set(source.subarray(0, 12));
      bytes.set([0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0], 12);
      bytes.set(source.subarray(12), 30);
      const view = new DataView(bytes.buffer);
      view.setUint32(4, bytes.length - 8, true);
      for (const [start, dimension] of [[24, width], [27, height]]) {
        const value = dimension - 1;
        bytes[start] = value & 255;
        bytes[start + 1] = (value >>> 8) & 255;
        bytes[start + 2] = (value >>> 16) & 255;
      }
      return bytes;
    };
    expect(inspectRaster(rasterDataUrl('webp', extended(1, 1)))).toEqual({ width: 1, height: 1, bytes: 56 });
    for (const [width, height] of [[10_001, 1], [1, 10_001], [10_000, 4_001], [2, 1]]) {
      expect(isSafeImage(rasterDataUrl('webp', extended(width, height)))).toBe(false);
    }
    const badReserved = extended(1, 1);
    badReserved[21] = 1;
    expect(isSafeImage(rasterDataUrl('webp', badReserved))).toBe(false);
    const noImage = extended(1, 1).subarray(0, 30);
    new DataView(noImage.buffer, noImage.byteOffset, noImage.byteLength).setUint32(4, 22, true);
    expect(isSafeImage(rasterDataUrl('webp', noImage))).toBe(false);
    const lossyBytes = Uint8Array.from(atob(lossy.split(',')[1]), character => character.charCodeAt(0));
    for (const [width, height] of [[0, 1], [1, 0], [10_001, 1], [10_000, 4_001]]) {
      const bytes = lossyBytes.slice();
      const view = new DataView(bytes.buffer);
      view.setUint16(26, width, true);
      view.setUint16(28, height, true);
      expect(isSafeImage(rasterDataUrl('webp', bytes))).toBe(false);
    }
  });

  it('rejects malformed WebP RIFF lengths, chunk bounds, codec signatures and versions', () => {
    const malformed: string[] = [];
    for (const offset of [0, 4, 8, 12, 16, 20, 24]) {
      const bytes = rasterBytes('webp');
      bytes[offset] ^= 0xff;
      malformed.push(rasterDataUrl('webp', bytes));
    }
    const badPadding = rasterBytes('webp');
    badPadding[badPadding.length - 1] = 1;
    malformed.push(rasterDataUrl('webp', badPadding));
    for (const value of malformed) expect(isSafeImage(value)).toBe(false);
  });

  it('bounds container scans even when many individually valid chunks or segments fit the byte limit', () => {
    const count = 4096;
    const jpeg = rasterBytes('jpeg');
    const jpegSegments = new Uint8Array(jpeg.length + 4 * count);
    jpegSegments.set(jpeg.subarray(0, 2));
    for (let index = 0; index < count; index++) jpegSegments.set([0xff, 0xe1, 0, 2], 2 + 4 * index);
    jpegSegments.set(jpeg.subarray(2), 2 + 4 * count);
    expect(isSafeImage(rasterDataUrl('jpeg', jpegSegments))).toBe(false);

    const pngBytes = rasterBytes('png');
    const pngChunks = new Uint8Array(pngBytes.length + 12 * count);
    pngChunks.set(pngBytes.subarray(0, -12));
    const ancillary = new Uint8Array(12);
    ancillary.set([0x70, 0x61, 0x44, 0x64], 4);
    new DataView(ancillary.buffer).setUint32(8, pngCrc(ancillary.subarray(4, 8)));
    for (let index = 0; index < count; index++) pngChunks.set(ancillary, pngBytes.length - 12 + 12 * index);
    pngChunks.set(pngBytes.subarray(-12), pngChunks.length - 12);
    expect(isSafeImage(rasterDataUrl('png', pngChunks))).toBe(false);

    const gif = rasterBytes('gif');
    const gifBlocks = new Uint8Array(gif.length + 3 * count);
    const descriptor = 25;
    gifBlocks.set(gif.subarray(0, descriptor));
    for (let index = 0; index < count; index++) gifBlocks.set([0x21, 0xfe, 0], descriptor + 3 * index);
    gifBlocks.set(gif.subarray(descriptor), descriptor + 3 * count);
    expect(isSafeImage(rasterDataUrl('gif', gifBlocks))).toBe(false);

    const webp = rasterBytes('webp');
    const webpChunks = new Uint8Array(webp.length + 18 + 8 * count);
    webpChunks.set(webp.subarray(0, 12));
    webpChunks.set([0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0], 12);
    webpChunks.set(webp.subarray(12), 30);
    for (let index = 0; index < count; index++) webpChunks.set([0x4a, 0x55, 0x4e, 0x4b, 0, 0, 0, 0], webp.length + 18 + 8 * index);
    new DataView(webpChunks.buffer).setUint32(4, webpChunks.length - 8, true);
    expect(isSafeImage(rasterDataUrl('webp', webpChunks))).toBe(false);
  });
});

describe('backup format', () => {
  it('roundtrips explicit versioned records and supports an empty backup', () => {
    const records = [record('one'), record('two', doc({ type: 'image', attrs: { src: png } }))];
    const serialized = serializeBackup(records);
    expect(JSON.parse(serialized)).toEqual({ format: 'document-editor', version: 1, documents: records });
    expect(parseBackup(serialized)).toEqual(records);
    expect(parseBackup(serializeBackup([]))).toEqual([]);
  });

  it.each([
    '', '{', '[]', '{}', JSON.stringify([record()]),
    envelope([record()], { format: 'other' }), envelope([record()], { version: 2 }),
    envelope([record()], { extra: 'not allowed' }), envelope([record(), record()]),
    envelope([{ ...record(), schemaVersion: 2 }]), envelope([{ ...record(), content: doc({ type: 'iframe' }) }]),
    envelope([{ ...record(), content: doc({ type: 'paragraph', attrs: { onload: 'evil' } }) }]),
    envelope(Array.from({ length: 101 }, (_, i) => record(String(i)))),
  ])('rejects invalid backups %#', input => expect(() => parseBackup(input)).toThrow());

  it('validates serialization and bounds the full UTF-8 input, including whitespace', () => {
    expect(() => serializeBackup([record(), record()])).toThrow();
    expect(() => serializeBackup([{ ...record(), schemaVersion: 2 } as unknown as DocumentRecord])).toThrow();
    expect(parseBackup(envelope([]).padEnd(MAX_BACKUP_BYTES, ' '))).toEqual([]);
    expect(parseBackup(envelope(Array.from({ length: 100 }, (_, i) => record(String(i)))))).toHaveLength(100);
    expect(() => parseBackup(' '.repeat(MAX_BACKUP_BYTES + 1))).toThrow();
    expect(() => parseBackup('é'.repeat(MAX_BACKUP_BYTES / 2 + 1))).toThrow();
    const oversizedImage = paddedPng(1_800_000);
    const oversized = Array.from({ length: 7 }, (_, i) => record(String(i), doc({ type: 'image', attrs: {
      src: oversizedImage,
    } })));
    expect(() => serializeBackup(oversized)).toThrow();
    expect(() => parseBackup(envelope(oversized))).toThrow();
  });
});

describe('secure document IDs', () => {
  it('uses randomUUID when available without a weak random fallback', () => {
    const randomUUID = vi.fn(() => 'secure-uuid');
    const getRandomValues = vi.fn();
    vi.stubGlobal('crypto', { randomUUID, getRandomValues });
    const weakRandom = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Weak randomness is forbidden'); });
    expect(createDocumentId()).toBe('secure-uuid');
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
    expect(weakRandom).not.toHaveBeenCalled();
  });

  it('uses getRandomValues when randomUUID is absent and sets UUID version/variant bits', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const weakRandom = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Weak randomness is forbidden'); });
    expect(createDocumentId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
    expect(weakRandom).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { randomUUID: undefined, getRandomValues: undefined }])('fails closed without secure randomness %#', crypto => {
    vi.stubGlobal('crypto', crypto);
    expect(() => createDocumentId()).toThrow('Secure random IDs are unavailable.');
  });

  it('uses the secure fallback for seeding and importing documents', async () => {
    let sequence = 0;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0);
      bytes[15] = ++sequence;
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const db = store();
    await db.seedIfEmpty();
    const [imported] = await db.importDocuments([record()]);
    const records = await db.list();
    expect(records).toHaveLength(2);
    expect(new Set(records.map(value => value.id)).size).toBe(2);
    expect(imported.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });
});

describe('DocumentStore', () => {
  it('persists, reads, updates revisions atomically and deletes', async () => {
    const db = store();
    expect(await db.list()).toEqual([]);
    expect(await db.get('absent')).toBeUndefined();
    expect(await db.create(record('one'))).toEqual(record('one'));
    expect(await db.list()).toEqual([record('one')]);
    const updated = await db.save({ ...record('one'), title: 'Updated' }, 0);
    expect(updated.title).toBe('Updated');
    expect(updated.revision).toBe(1);
    expect(updated.createdAt).toBe(timestamp);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(timestamp));
    expect(await db.get('one')).toEqual(updated);
    await db.delete('one', 1);
    expect(await db.list()).toEqual([]);
  });

  it('uses add on create and never overwrites an existing ID', async () => {
    const db = store();
    await db.create(record());
    await expect(db.create({ ...record(), title: 'Overwrite' })).rejects.toThrow();
    expect((await db.get('original'))?.title).toBe('Catatan');
  });

  it('does not resurrect a deleted or missing document with save', async () => {
    const db = store();
    await expect(db.save(record('missing'), 0)).rejects.toBeInstanceOf(MissingDocumentError);
    await expect(db.delete('missing', 0)).rejects.toBeInstanceOf(MissingDocumentError);
    await db.create(record());
    await db.delete('original', 0);
    await expect(db.save(record(), 0)).rejects.toBeInstanceOf(MissingDocumentError);
    expect(await db.list()).toEqual([]);
  });

  it('detects stale saves and deletes across two store instances', async () => {
    const a = store('shared');
    const b = store('shared');
    await a.create(record());
    const stale = (await b.get('original'))!;
    await a.save({ ...record(), title: 'Winner' }, 0);
    await expect(b.save({ ...stale, title: 'Lost' }, 0)).rejects.toBeInstanceOf(ConflictError);
    await expect(b.delete('original', 0)).rejects.toBeInstanceOf(ConflictError);
    expect((await a.get('original'))?.title).toBe('Winner');
    await b.delete('original', 1);
    await expect(a.save(record(), 1)).rejects.toBeInstanceOf(MissingDocumentError);
  });

  it('allows only one simultaneous save for the same expected revision', async () => {
    const a = store('racing');
    const b = store('racing');
    await a.create(record());
    const results = await Promise.allSettled([
      a.save({ ...record(), title: 'A' }, 0), b.save({ ...record(), title: 'B' }, 0),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    expect((await a.get('original'))?.revision).toBe(1);
  });

  it('preserves original creation metadata rather than trusting stale write metadata', async () => {
    const db = store();
    await db.create(record());
    const saved = await db.save({ ...record(), createdAt: '2025-01-01T00:00:00.000Z', revision: 99 }, 0);
    expect(saved.createdAt).toBe(timestamp);
    expect(saved.revision).toBe(1);
  });

  it('validates creates, saves, revisions and imports before writing', async () => {
    const db = store();
    await expect(db.create({ ...record(), content: doc({ type: 'script' }) })).rejects.toThrow();
    await db.create(record());
    await expect(db.save({ ...record(), title: 'x'.repeat(201) }, 0)).rejects.toThrow();
    await expect(db.save(record(), -1)).rejects.toThrow();
    await expect(db.delete('original', 0.5)).rejects.toThrow();
    await expect(db.importDocuments([record('good'), { ...record('bad'), content: doc({ type: 'iframe' }) }])).rejects.toThrow();
    await expect(db.importDocuments([record('duplicate'), record('duplicate')])).rejects.toThrow();
    await expect(db.importDocuments(Array.from({ length: 101 }, (_, i) => record(String(i))))).rejects.toThrow();
    expect(await db.list()).toEqual([record()]);
  });

  it('imports using new IDs, timestamps and revision zero without overwriting', async () => {
    const db = store();
    await db.create(record());
    const imported = await db.importDocuments([{ ...record(), revision: 7 }, record('second')]);
    expect(imported).toHaveLength(2);
    expect(new Set(imported.map(item => item.id)).size).toBe(2);
    for (const item of imported) {
      expect(['original', 'second']).not.toContain(item.id);
      expect(item.revision).toBe(0);
      expect(item.createdAt).toBe(item.updatedAt);
      expect(Date.parse(item.createdAt)).toBeGreaterThan(Date.parse(timestamp));
    }
    expect(await db.get('original')).toEqual(record());
    expect(await db.list()).toHaveLength(3);
    expect(await db.importDocuments([])).toEqual([]);
  });

  it('rolls back all imported documents when a later add fails', async () => {
    const db = store();
    await db.create(record());
    const add = IDBObjectStore.prototype.add;
    let calls = 0;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      if (++calls === 2) throw new DOMException('Storage is full', 'QuotaExceededError');
      return add.apply(this, args);
    });
    await expect(db.importDocuments([record('a'), record('b')])).rejects.toMatchObject({ name: 'QuotaExceededError' });
    spy.mockRestore();
    expect(await db.list()).toEqual([record()]);
  });

  it('aborts an entire import on an ID collision instead of overwriting existing data', async () => {
    const db = store();
    await db.create(record('existing-id'));
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn().mockReturnValueOnce('fresh-id').mockReturnValueOnce('existing-id'),
    });
    await expect(db.importDocuments([record('a'), record('b')])).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await db.list()).toEqual([record('existing-id')]);
    expect(await db.get('fresh-id')).toBeUndefined();
  });

  it('seeds exactly once across concurrent instances and only into an empty store', async () => {
    const a = store('seed');
    const b = store('seed');
    await Promise.all([a.seedIfEmpty(), b.seedIfEmpty(), a.seedIfEmpty()]);
    const seeded = await a.list();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].revision).toBe(0);
    expect(seeded[0].content).toEqual(sampleContent());
    await a.seedIfEmpty();
    expect(await b.list()).toEqual(seeded);
    const existing = store();
    await existing.create(record());
    await existing.seedIfEmpty();
    expect(await existing.list()).toEqual([record()]);
  });

  it('exposes database opening failures instead of returning or seeding fallback data', async () => {
    const failure = new DOMException('Access denied', 'SecurityError');
    vi.spyOn(factory, 'open').mockImplementation(() => { throw failure; });
    const db = store();
    await expect(db.seedIfEmpty()).rejects.toBe(failure);
    await expect(db.list()).rejects.toBe(failure);
  });

  it('does not seed if the count operation fails', async () => {
    const db = store();
    const failure = new DOMException('Count failed', 'UnknownError');
    const spy = vi.spyOn(IDBObjectStore.prototype, 'count').mockImplementation(() => { throw failure; });
    await expect(db.seedIfEmpty()).rejects.toBe(failure);
    spy.mockRestore();
    expect(await db.list()).toEqual([]);
  });

  it('rejects writes through a closed store and permits another instance to reopen data', async () => {
    const a = store('reopen');
    await a.create(record());
    await a.close();
    await a.close();
    await expect(a.create(record('later'))).rejects.toThrow();
    const b = store('reopen');
    expect(await b.get('original')).toEqual(record());
  });
});
