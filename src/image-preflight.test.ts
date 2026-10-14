import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeDocumentImages, decodeLocalRaster } from './image-preflight';
import type { DocumentRecord } from './data';
import { TINY_PNG } from './raster-fixtures';

const png = TINY_PNG;
let sources: string[];
let failDecode: boolean;
let width: number;
let height: number;

beforeEach(() => {
  sources = [];
  failDecode = false;
  width = 1;
  height = 1;
  class DecoderImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      if (!value) return;
      sources.push(value);
      queueMicrotask(() => { if (failDecode) this.onerror?.(); else this.onload?.(); });
    }
  }
  vi.stubGlobal('Image', DecoderImage);
});
afterEach(() => { vi.unstubAllGlobals(); });

const record = (content: DocumentRecord['content']): DocumentRecord => ({
  id: 'image-document', title: 'Gambar', content, schemaVersion: 1, revision: 0,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('local raster decoding', () => {
  it('rejects remote and fake raster sources before constructing a decoder', async () => {
    await expect(decodeLocalRaster('https://example.com/private.png')).rejects.toThrow();
    await expect(decodeLocalRaster('data:image/png;base64,AAAA')).rejects.toThrow();
    expect(sources).toEqual([]);
  });

  it('requires successful decoding in addition to valid raster preflight', async () => {
    failDecode = true;
    await expect(decodeLocalRaster(png)).rejects.toThrow(/gambar/i);
    expect(sources).toEqual([png]);
  });

  it('checks the decoded intrinsic resolution again', async () => {
    width = 10000;
    height = 5000;
    await expect(decodeLocalRaster(png)).rejects.toThrow(/resolusi/i);
  });

  it('accepts a successfully decoded bounded local raster', async () => {
    await expect(decodeLocalRaster(png)).resolves.toBeUndefined();
    expect(sources).toEqual([png]);
  });

  it('decodes each distinct imported source once before returning', async () => {
    const document = record({ type: 'doc', content: [
      { type: 'image', attrs: { src: png } },
      { type: 'blockquote', content: [{ type: 'image', attrs: { src: png } }] },
    ] });
    await expect(decodeDocumentImages([document, { ...document, id: 'second' }])).resolves.toBeUndefined();
    expect(sources).toEqual([png]);
  });

  it('rejects the imported document batch when embedded decoding fails', async () => {
    failDecode = true;
    await expect(decodeDocumentImages([record({ type: 'doc', content: [{ type: 'image', attrs: { src: png } }] })])).rejects.toThrow(/gambar/i);
  });
});
