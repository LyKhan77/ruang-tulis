import type { JSONContent } from '@tiptap/core';
import { isSafeImage, type DocumentRecord } from './data';

const MAX_DECODED_PIXELS = 40_000_000;
const DECODE_TIMEOUT_MS = 10_000;

/** Only bounded, locally embedded raster sources reach the browser decoder. */
export async function decodeLocalRaster(source: string): Promise<void> {
  if (!isSafeImage(source)) throw new Error('Sumber gambar tidak valid, terlalu besar, atau melebihi batas resolusi.');
  await new Promise<void>((resolve, reject) => {
    const image = new Image();
    const timeout = window.setTimeout(() => {
      image.onload = null;
      image.onerror = null;
      image.src = '';
      reject(new Error('Gambar tidak dapat didekode dalam batas waktu.'));
    }, DECODE_TIMEOUT_MS);
    image.onload = () => {
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height || width * height > MAX_DECODED_PIXELS) reject(new Error('Resolusi gambar terlalu besar atau tidak valid.'));
      else resolve();
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      reject(new Error('Berkas gambar tidak dapat dibaca. Cadangan belum diimpor.'));
    };
    image.src = source;
  });
}

/** Caller awaits this before opening its atomic import transaction. */
export async function decodeDocumentImages(documents: DocumentRecord[]): Promise<void> {
  const sources = new Set<string>();
  const pending: JSONContent[] = documents.map((document) => document.content);
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'image') {
      if (typeof node.attrs?.src !== 'string') throw new Error('Sumber gambar dalam cadangan tidak valid.');
      sources.add(node.attrs.src);
    }
    if (node.content) pending.push(...node.content);
  }
  // Serial decoding bounds simultaneous decompression memory. Any rejection
  // returns before the caller can commit even one imported document.
  for (const source of sources) await decodeLocalRaster(source);
}
