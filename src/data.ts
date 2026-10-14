import type { JSONContent } from '@tiptap/core';

export interface DocumentRecord {
  id: string;
  title: string;
  content: JSONContent;
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export const MAX_BACKUP_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DOCUMENTS = 100;
const MAX_DEPTH = 24;
const MAX_NODES = 30_000;
const MAX_TABLE_COLUMNS = 1_000;
const encoder = new TextEncoder();

// These are schema names, not HTML tags. No editor module is imported here.
const BLOCKS: Record<string, true> = {
  paragraph: true, heading: true, bulletList: true, orderedList: true,
  blockquote: true, codeBlock: true, horizontalRule: true, image: true, table: true,
};
const MARKS: Record<string, true> = {
  bold: true, italic: true, underline: true, strike: true, code: true, link: true,
};
const ALIGNMENTS: Record<string, true> = { left: true, center: true, right: true, justify: true };
const TARGETS: Record<string, true> = { _blank: true, _self: true, _parent: true, _top: true };
const RELATIONS: Record<string, true> = {
  noopener: true, noreferrer: true, nofollow: true, ugc: true, sponsored: true, external: true,
};
const has = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);
const member = (values: Record<string, true>, key: string): boolean => has(values, key);
function invalid(message: string): never {
  throw new Error(`Invalid document data: ${message}`);
}

type ObjectValue = Record<string, unknown>;
interface Budget { nodes: number; textBytes: number; imageBytes: number; stringBytes: number }
const newBudget = (): Budget => ({ nodes: 0, textBytes: 0, imageBytes: 0, stringBytes: 0 });

function object(value: unknown, label: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain JSON object`);
  if (Object.getOwnPropertySymbols(value).length) invalid(`${label} contains symbol properties`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!has(descriptor, 'value') || !descriptor.enumerable || descriptor.value === undefined) {
      invalid(`${label} contains an accessor, hidden property or undefined value`);
    }
  }
  return value as ObjectValue;
}

function keys(value: ObjectValue, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`unsupported ${label} property: ${key}`);
}

function array(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} must be a bounded array`);
  if (Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    invalid(`${label} must not contain holes or extra properties`);
  }
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !has(descriptor, 'value') || !descriptor.enumerable || descriptor.value === undefined) {
      invalid(`${label} contains a hole, accessor or undefined value`);
    }
  }
  return value;
}

function validUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function string(value: unknown, maximum: number, label: string, budget?: Budget, multiline = false): string {
  if (typeof value !== 'string' || value.length > maximum || !validUnicode(value)) invalid(`${label} must be a bounded Unicode string`);
  if ((multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) {
    invalid(`${label} contains control characters`);
  }
  if (budget) {
    budget.stringBytes += encoder.encode(value).byteLength;
    if (budget.stringBytes > MAX_BACKUP_BYTES) invalid('string data exceeds the backup byte limit');
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function boundedJSON(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined || result.length > MAX_BACKUP_BYTES || encoder.encode(result).byteLength > MAX_BACKUP_BYTES) {
    invalid('JSON exceeds the backup byte limit');
  }
  return result;
}

/** Allows only absolute HTTP, HTTPS, and mailto links; never executable URLs. */
export function isSafeLink(value: string): boolean {
  if (typeof value !== 'string' || !value || value.length > 2048 || !validUnicode(value)) return false;
  if (/[\s\u0000-\u001f\u007f\\]/u.test(value)) return false;
  if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return Boolean(url.hostname) && !url.username && !url.password;
    if (url.protocol === 'mailto:') return Boolean(url.pathname) && !/%(?:0a|0d)/i.test(value);
    return false;
  } catch {
    return false;
  }
}

interface RasterDimensions { width: number; height: number }
export interface RasterInfo extends RasterDimensions { bytes: number }
const MAX_RASTER_DIMENSION = 10_000;
const MAX_RASTER_PIXELS = 40_000_000;
const MAX_RASTER_CHUNKS = 4096;

function rasterDimensions(width: number, height: number): RasterDimensions | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
      width > MAX_RASTER_DIMENSION || height > MAX_RASTER_DIMENSION || width * height > MAX_RASTER_PIXELS) return undefined;
  return { width, height };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function pngChecksum(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[offset]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(bytes: Uint8Array, view: DataView): RasterDimensions | undefined {
  if (bytes.length < 57 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return undefined;
  let dimensions: RasterDimensions | undefined;
  let palette = false;
  let imageData = false;
  let compressedBytes = 0;
  const zlibHeader: number[] = [];
  let dataEnded = false;
  let color = -1;
  let depth = 0;
  let offset = 8;
  for (let chunks = 0; offset + 12 <= bytes.length && chunks < MAX_RASTER_CHUNKS; chunks++) {
    const length = view.getUint32(offset);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) return undefined;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || (bytes[offset + 6] & 32) !== 0 ||
        pngChecksum(bytes, offset + 4, end) !== view.getUint32(end)) return undefined;
    const start = offset + 8;
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) return undefined;
      dimensions = rasterDimensions(view.getUint32(start), view.getUint32(start + 4));
      depth = bytes[start + 8];
      color = bytes[start + 9];
      const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!dimensions || !depths[color]?.includes(depth) || bytes[start + 10] !== 0 ||
          bytes[start + 11] !== 0 || bytes[start + 12] > 1) return undefined;
    } else {
      if (!dimensions) return undefined;
      if (type === 'PLTE') {
        if (palette || imageData || length === 0 || length % 3 !== 0 || length > 768 ||
            color === 0 || color === 4 || (color === 3 && length / 3 > 2 ** depth)) return undefined;
        palette = true;
      } else if (type === 'IDAT') {
        if (dataEnded || (color === 3 && !palette)) return undefined;
        imageData = true;
        compressedBytes += length;
        for (let index = start; index < end && zlibHeader.length < 2; index++) zlibHeader.push(bytes[index]);
      } else if (type === 'IEND') {
        const [cmf, flg] = zlibHeader;
        return length === 0 && imageData && compressedBytes >= 6 && zlibHeader.length === 2 &&
          (cmf & 15) === 8 && (cmf >>> 4) <= 7 && (flg & 32) === 0 && ((cmf << 8) | flg) % 31 === 0 &&
          end + 4 === bytes.length ? dimensions : undefined;
      } else {
        // Unknown critical chunks cannot be safely interpreted.
        if ((bytes[offset + 4] & 32) === 0) return undefined;
        if (imageData) dataEnded = true;
      }
    }
    offset = end + 4;
  }
  return undefined;
}

function inspectGif(bytes: Uint8Array, view: DataView): RasterDimensions | undefined {
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.subarray(0, 6)))) return undefined;
  const dimensions = rasterDimensions(view.getUint16(6, true), view.getUint16(8, true));
  if (!dimensions) return undefined;
  const globalPalette = (bytes[10] & 128) !== 0;
  let offset = 13 + (globalPalette ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0);
  if (offset >= bytes.length || (globalPalette && bytes[11] >= 2 ** ((bytes[10] & 7) + 1))) return undefined;
  let images = 0;
  const subBlocks = (): boolean => {
    while (offset < bytes.length) {
      const length = bytes[offset++];
      if (length === 0) return true;
      if (offset + length > bytes.length) return false;
      offset += length;
    }
    return false;
  };
  for (let blocks = 0; offset < bytes.length && blocks < MAX_RASTER_CHUNKS; blocks++) {
    const type = bytes[offset++];
    if (type === 0x3b) return images > 0 && offset === bytes.length ? dimensions : undefined;
    if (type === 0x21) {
      if (offset >= bytes.length) return undefined;
      const label = bytes[offset++];
      if (label === 0xf9) {
        if (offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0 ||
            (bytes[offset + 1] & 0xe0) !== 0 || ((bytes[offset + 1] >>> 2) & 7) > 3) return undefined;
        offset += 6;
      } else {
        if ((label === 0xff && bytes[offset] !== 11) || (label === 0x01 && bytes[offset] !== 12)) return undefined;
        if (!subBlocks()) return undefined;
      }
    } else if (type === 0x2c) {
      if (offset + 9 > bytes.length) return undefined;
      const left = view.getUint16(offset, true);
      const top = view.getUint16(offset + 2, true);
      const frame = rasterDimensions(view.getUint16(offset + 4, true), view.getUint16(offset + 6, true));
      const packed = bytes[offset + 8];
      if (!frame || left + frame.width > dimensions.width || top + frame.height > dimensions.height || (packed & 0x18) !== 0) return undefined;
      offset += 9;
      const localPalette = (packed & 128) !== 0;
      if (!globalPalette && !localPalette) return undefined;
      if (localPalette) offset += 3 * (2 ** ((packed & 7) + 1));
      if (offset + 2 > bytes.length || bytes[offset] < 2 || bytes[offset] > 8 || bytes[offset + 1] === 0) return undefined;
      offset++;
      if (!subBlocks()) return undefined;
      images++;
    } else return undefined;
  }
  return undefined;
}

function inspectJpeg(bytes: Uint8Array, view: DataView): RasterDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  let dimensions: RasterDimensions | undefined;
  let components: number[] = [];
  let scans = 0;
  let entropyBytes = 0;
  for (let segments = 0; offset < bytes.length && segments < MAX_RASTER_CHUNKS; segments++) {
    if (bytes[offset++] !== 0xff) return undefined;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset++];
    if (marker === 0xd9) return dimensions && scans > 0 && entropyBytes > 0 && offset === bytes.length ? dimensions : undefined;
    if (marker === 0 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) return undefined;
    const length = view.getUint16(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) return undefined;
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      if (dimensions || length < 11) return undefined;
      dimensions = rasterDimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
      const count = bytes[offset + 7];
      if (!dimensions || ![8, 12].includes(bytes[offset + 2]) || count < 1 || count > 4 || length !== 8 + 3 * count) return undefined;
      components = [];
      for (let index = 0; index < count; index++) {
        const start = offset + 8 + index * 3;
        const sampling = bytes[start + 1];
        if (components.includes(bytes[start]) || (sampling >> 4) < 1 || (sampling >> 4) > 4 ||
            (sampling & 15) < 1 || (sampling & 15) > 4 || bytes[start + 2] > 3) return undefined;
        components.push(bytes[start]);
      }
    } else if (marker === 0xdb) {
      if (length < 67) return undefined;
      let cursor = offset + 2;
      while (cursor < end) {
        const table = bytes[cursor++];
        const precision = table >>> 4;
        const size = precision === 0 ? 64 : 128;
        if (precision > 1 || (table & 15) > 3 || cursor + size > end) return undefined;
        for (let index = cursor; index < cursor + size; index += precision + 1) {
          if ((precision === 0 ? bytes[index] : view.getUint16(index)) === 0) return undefined;
        }
        cursor += size;
      }
    } else if (marker === 0xc4) {
      if (length < 20) return undefined;
      let cursor = offset + 2;
      while (cursor < end) {
        if (cursor + 17 > end || (bytes[cursor] & 0xec) !== 0) return undefined;
        cursor++;
        let count = 0;
        let available = 1;
        for (let index = 0; index < 16; index++) {
          const symbols = bytes[cursor++];
          count += symbols;
          available = 2 * available - symbols;
          if (available < 0) return undefined;
        }
        if (count === 0 || count > 256 || cursor + count > end) return undefined;
        cursor += count;
      }
    } else if (marker === 0xdd) {
      if (length !== 4) return undefined;
    } else if (marker === 0xda) {
      const count = bytes[offset + 2];
      if (!dimensions || count < 1 || count > components.length || length !== 6 + 2 * count) return undefined;
      const selected = new Set<number>();
      for (let index = 0; index < count; index++) {
        const id = bytes[offset + 3 + index * 2];
        const tables = bytes[offset + 4 + index * 2];
        if (!components.includes(id) || selected.has(id) || (tables >> 4) > 3 || (tables & 15) > 3) return undefined;
        selected.add(id);
      }
      if (bytes[end - 3] > bytes[end - 2] || bytes[end - 2] > 63 ||
          (bytes[end - 1] >> 4) > 13 || (bytes[end - 1] & 15) > 13) return undefined;
      scans++;
      offset = end;
      // Entropy data is scanned in-place; stuffed FF and restart markers are not segments.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { entropyBytes++; offset++; continue; }
        const start = offset++;
        while (offset < bytes.length && bytes[offset] === 0xff) offset++;
        if (offset >= bytes.length) return undefined;
        const next = bytes[offset];
        if (next === 0) { entropyBytes++; offset++; continue; }
        if (next >= 0xd0 && next <= 0xd7) { offset++; continue; }
        offset = start;
        break;
      }
      continue;
    } else if (marker === 0xdc || marker < 0xc0) return undefined;
    offset = end;
  }
  return undefined;
}

function webpFrame(bytes: Uint8Array, view: DataView, type: string, start: number, length: number): RasterDimensions | undefined {
  if (type === 'VP8L') {
    if (length < 6 || bytes[start] !== 0x2f || (bytes[start + 4] & 0xe0) !== 0) return undefined;
    const packed = view.getUint32(start + 1, true);
    return rasterDimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
  }
  if (type !== 'VP8 ' || length <= 10 || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) return undefined;
  const tag = bytes[start] | (bytes[start + 1] << 8) | (bytes[start + 2] << 16);
  if ((tag & 1) !== 0 || ((tag >>> 1) & 7) > 3 || (tag & 16) === 0 || (tag >>> 5) === 0 || (tag >>> 5) > length - 10) return undefined;
  return rasterDimensions(view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff);
}

function inspectWebp(bytes: Uint8Array, view: DataView): RasterDimensions | undefined {
  if (bytes.length < 26 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
      String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP' || view.getUint32(4, true) !== bytes.length - 8) return undefined;
  let canvas: RasterDimensions | undefined;
  let image: RasterDimensions | undefined;
  let animated = false;
  let animationHeader = false;
  let frames = 0;
  const uint24 = (start: number): number => bytes[start] | (bytes[start + 1] << 8) | (bytes[start + 2] << 16);
  let offset = 12;
  for (let chunks = 0; offset + 8 <= bytes.length && chunks < MAX_RASTER_CHUNKS; chunks++) {
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    const next = end + (length & 1);
    if (next > bytes.length || ((length & 1) !== 0 && bytes[end] !== 0)) return undefined;
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10 || (bytes[start] & 0xc1) !== 0 ||
          bytes[start + 1] !== 0 || bytes[start + 2] !== 0 || bytes[start + 3] !== 0) return undefined;
      canvas = rasterDimensions(uint24(start + 4) + 1, uint24(start + 7) + 1);
      if (!canvas) return undefined;
      animated = (bytes[start] & 2) !== 0;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (image || animated) return undefined;
      image = webpFrame(bytes, view, type, start, length);
      if (!image || (canvas && (image.width !== canvas.width || image.height !== canvas.height))) return undefined;
    } else if (type === 'ANIM') {
      if (!animated || animationHeader || frames > 0 || length !== 6) return undefined;
      animationHeader = true;
    } else if (type === 'ANMF') {
      if (!canvas || !animated || !animationHeader || length < 24 || (bytes[start + 15] & 0xfc) !== 0) return undefined;
      const frame = rasterDimensions(uint24(start + 6) + 1, uint24(start + 9) + 1);
      if (!frame || 2 * uint24(start) + frame.width > canvas.width || 2 * uint24(start + 3) + frame.height > canvas.height) return undefined;
      let frameImage = false;
      let inner = start + 16;
      for (let parts = 0; inner + 8 <= end && parts < MAX_RASTER_CHUNKS; parts++) {
        const kind = String.fromCharCode(...bytes.subarray(inner, inner + 4));
        const size = view.getUint32(inner + 4, true);
        const data = inner + 8;
        const after = data + size + (size & 1);
        if (after > end || ((size & 1) !== 0 && bytes[data + size] !== 0)) return undefined;
        if (kind === 'VP8 ' || kind === 'VP8L') {
          const actual = webpFrame(bytes, view, kind, data, size);
          if (frameImage || !actual || actual.width !== frame.width || actual.height !== frame.height) return undefined;
          frameImage = true;
        } else if (kind !== 'ALPH' || frameImage || size < 1) return undefined;
        inner = after;
      }
      if (inner !== end || !frameImage) return undefined;
      frames++;
    } else if (type === 'ALPH') {
      if (!canvas || animated || image || length < 1) return undefined;
    } else if (!canvas) return undefined;
    offset = next;
  }
  if (offset !== bytes.length) return undefined;
  return animated ? (frames > 0 ? canvas : undefined) : image;
}

/**
 * Performs bounded, DOM-independent container inspection, not pixel decoding.
 * Callers that import images must also decode raster content before committing.
 */
export function inspectRaster(value: string): RasterInfo | undefined {
  if (typeof value !== 'string' || value.length > 64 + 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) return undefined;
  const prefix = /^data:image\/(png|jpeg|gif|webp);base64,/.exec(value);
  if (!prefix) return undefined;
  const payload = value.slice(prefix[0].length);
  if (!payload.length || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return undefined;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const decoded = payload.length / 4 * 3 - padding;
  if (decoded <= 0 || decoded > MAX_IMAGE_BYTES) return undefined;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (padding && (alphabet.indexOf(payload[payload.length - padding - 1]) & (padding === 2 ? 15 : 3)) !== 0) return undefined;
  if (typeof globalThis.atob !== 'function') return undefined;
  let binary: string;
  try { binary = globalThis.atob(payload); } catch { return undefined; }
  if (binary.length !== decoded) return undefined;
  const bytes = new Uint8Array(decoded);
  for (let index = 0; index < decoded; index++) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let dimensions: RasterDimensions | undefined;
  switch (prefix[1]) {
    case 'png': dimensions = inspectPng(bytes, view); break;
    case 'jpeg': dimensions = inspectJpeg(bytes, view); break;
    case 'gif': dimensions = inspectGif(bytes, view); break;
    case 'webp': dimensions = inspectWebp(bytes, view); break;
  }
  return dimensions ? { ...dimensions, bytes: decoded } : undefined;
}

function imageBytes(value: unknown): number | undefined {
  return typeof value === 'string' ? inspectRaster(value)?.bytes : undefined;
}

export function isSafeImage(value: string): boolean { return inspectRaster(value) !== undefined; }

function attributes(node: ObjectValue, allowed: readonly string[]): ObjectValue | undefined {
  if (!has(node, 'attrs')) return undefined;
  const attrs = object(node.attrs, 'attributes');
  keys(attrs, allowed, 'attribute');
  return attrs;
}

function nullableString(value: unknown, maximum: number, label: string, budget: Budget): string | null {
  return value === null ? null : string(value, maximum, label, budget);
}

function validateMarks(value: unknown, budget: Budget): NonNullable<JSONContent['marks']> {
  const values = array(value, 6, 'marks');
  const seen = new Set<string>();
  if (values.length > 1 && values.some(item => object(item, 'mark').type === 'code')) {
    invalid('code cannot be combined with other marks');
  }
  return values.map(item => {
    const mark = object(item, 'mark');
    keys(mark, ['type', 'attrs'], 'mark');
    const type = string(mark.type, 32, 'mark type');
    if (!member(MARKS, type) || seen.has(type)) invalid('unsupported or duplicate mark');
    seen.add(type);
    const attrs = attributes(mark, type === 'link' ? ['href', 'title', 'target', 'rel', 'class'] : []);
    if (type !== 'link') return { type, ...(attrs ? { attrs: {} } : {}) };
    if (!attrs || !isSafeLink(attrs.href as string)) invalid('unsafe link href');
    const result: ObjectValue = { href: string(attrs.href, 2048, 'link href', budget) };
    if (has(attrs, 'title')) result.title = nullableString(attrs.title, 512, 'link title', budget);
    if (has(attrs, 'class')) {
      if (attrs.class !== null) invalid('non-default link classes are unsupported');
      result.class = null;
    }
    if (has(attrs, 'target')) {
      if (attrs.target !== null && (typeof attrs.target !== 'string' || !member(TARGETS, attrs.target))) invalid('unsupported link target');
      result.target = attrs.target;
    }
    if (has(attrs, 'rel')) {
      if (attrs.rel !== null) {
        const rel = string(attrs.rel, 256, 'link rel', budget);
        if (rel && rel.split(/\s+/).some(token => !member(RELATIONS, token))) invalid('unsupported link rel');
      }
      result.rel = attrs.rel;
    }
    return { type, attrs: result };
  });
}

function validateNode(input: unknown, depth: number, budget: Budget): JSONContent {
  if (depth > MAX_DEPTH || ++budget.nodes > MAX_NODES) invalid('content exceeds the depth or node limit');
  const node = object(input, 'node');
  keys(node, ['type', 'attrs', 'content', 'marks', 'text'], 'node');
  const type = string(node.type, 32, 'node type');
  if (!member(BLOCKS, type) && !['doc', 'text', 'hardBreak', 'listItem', 'tableRow', 'tableCell', 'tableHeader'].includes(type)) {
    invalid(`unsupported node: ${type}`);
  }
  const output: JSONContent = { type };
  if (has(node, 'marks')) {
    if (type !== 'text' && type !== 'hardBreak') invalid('marks are only allowed on inline nodes');
    output.marks = validateMarks(node.marks, budget);
  }
  if (type === 'text') {
    if (has(node, 'attrs') || has(node, 'content')) invalid('text nodes cannot have attributes or children');
    const text = string(node.text, MAX_TEXT_BYTES, 'text', budget, true);
    if (!text.length) invalid('text nodes must not be empty');
    budget.textBytes += encoder.encode(text).byteLength;
    if (budget.textBytes > MAX_TEXT_BYTES) invalid('text exceeds the byte limit');
    output.text = text;
    return output;
  }
  if (has(node, 'text')) invalid('only text nodes may have text');
  let allowed: string[] = [];
  switch (type) {
    case 'paragraph': allowed = ['textAlign', 'indent']; break;
    case 'heading': allowed = ['level', 'textAlign', 'indent']; break;
    case 'orderedList': allowed = ['start', 'type']; break;
    case 'codeBlock': allowed = ['language']; break;
    case 'image': allowed = ['src', 'alt', 'title', 'width', 'height']; break;
    case 'tableCell': case 'tableHeader': allowed = ['colspan', 'rowspan', 'colwidth', 'align']; break;
  }
  const attrs = attributes(node, allowed);
  const cleaned: ObjectValue = {};
  if (attrs) {
    if (has(attrs, 'level')) cleaned.level = integer(attrs.level, 1, 3, 'heading level');
    if (has(attrs, 'textAlign')) {
      if (attrs.textAlign !== null && (typeof attrs.textAlign !== 'string' || !member(ALIGNMENTS, attrs.textAlign))) invalid('unsupported text alignment');
      cleaned.textAlign = attrs.textAlign;
    }
    if (has(attrs, 'indent')) cleaned.indent = integer(attrs.indent, 0, 8, 'indent');
    if (has(attrs, 'start')) cleaned.start = integer(attrs.start, 1, Number.MAX_SAFE_INTEGER, 'ordered list start');
    if (has(attrs, 'type')) {
      if (attrs.type !== null && !['1', 'a', 'A', 'i', 'I'].includes(attrs.type as string)) invalid('unsupported ordered list type');
      cleaned.type = attrs.type;
    }
    if (has(attrs, 'language')) cleaned.language = nullableString(attrs.language, 100, 'code language', budget);
    if (has(attrs, 'src')) {
      const size = imageBytes(attrs.src);
      if (size === undefined) invalid('unsafe or oversized image');
      budget.imageBytes += size;
      if (budget.imageBytes > MAX_BACKUP_BYTES) invalid('decoded images exceed the backup byte limit');
      cleaned.src = string(attrs.src, MAX_BACKUP_BYTES, 'image source', budget);
    }
    for (const key of ['alt', 'title']) if (has(attrs, key)) cleaned[key] = nullableString(attrs[key], key === 'alt' ? 2000 : 512, `image ${key}`, budget);
    for (const key of ['width', 'height']) {
      if (!has(attrs, key)) continue;
      const raw = attrs[key];
      if (raw === null) { cleaned[key] = null; continue; }
      // Tiptap's HTML parser can emit numeric strings for pasted dimensions.
      const dimension = typeof raw === 'string' && raw.length <= 16 && /^\d+(?:\.\d+)?(?:px)?$/.test(raw)
        ? Number(raw.replace(/px$/, '')) : raw;
      if (typeof dimension !== 'number' || !Number.isFinite(dimension) || dimension <= 0 || dimension > 10_000) {
        invalid(`image ${key} must be null or a positive dimension up to 10000`);
      }
      cleaned[key] = dimension;
    }
    if (has(attrs, 'colspan')) cleaned.colspan = integer(attrs.colspan, 1, MAX_TABLE_COLUMNS, 'colspan');
    if (has(attrs, 'rowspan')) cleaned.rowspan = integer(attrs.rowspan, 1, MAX_NODES, 'rowspan');
    if (has(attrs, 'align')) {
      if (attrs.align !== null && !['left', 'center', 'right'].includes(attrs.align as string)) invalid('unsupported table cell alignment');
      cleaned.align = attrs.align;
    }
    if (has(attrs, 'colwidth')) {
      cleaned.colwidth = attrs.colwidth === null ? null : array(attrs.colwidth, MAX_TABLE_COLUMNS, 'colwidth').map(value => integer(value, 0, 100_000, 'column width'));
      if (cleaned.colwidth !== null && (cleaned.colwidth as number[]).length !== (cleaned.colspan ?? 1)) invalid('colwidth must match colspan');
    }
    output.attrs = cleaned;
  }
  // Heading's default level is 1, consistent with the editor schema.
  if (type === 'image' && (!attrs || !has(attrs, 'src'))) invalid('image source is required');
  const children = has(node, 'content') ? array(node.content, MAX_NODES, 'content') : [];
  if (['hardBreak', 'horizontalRule', 'image'].includes(type) && has(node, 'content')) invalid('leaf nodes cannot have content');
  if (has(node, 'content')) output.content = children.map(child => validateNode(child, depth + 1, budget));
  const content = output.content ?? [];
  const only = (test: (child: JSONContent) => boolean): boolean => content.every(test);
  const isBlock = (child: JSONContent): boolean => typeof child.type === 'string' && member(BLOCKS, child.type);
  switch (type) {
    case 'doc': case 'blockquote': case 'tableCell': case 'tableHeader':
      if (!content.length || !only(isBlock)) invalid(`${type} requires block content`);
      break;
    case 'paragraph': case 'heading':
      if (!only(child => child.type === 'text' || child.type === 'hardBreak')) invalid(`${type} requires inline content`);
      break;
    case 'codeBlock':
      if (!only(child => child.type === 'text' && !(child.marks?.length))) invalid('code blocks require unmarked text');
      break;
    case 'bulletList': case 'orderedList':
      if (!content.length || !only(child => child.type === 'listItem')) invalid('lists require list items');
      break;
    case 'listItem':
      if (content[0]?.type !== 'paragraph' || !only(isBlock)) invalid('list items must start with a paragraph');
      break;
    case 'table':
      if (!content.length || !only(child => child.type === 'tableRow')) invalid('tables require rows');
      validateTable(content);
      break;
    case 'tableRow':
      if (!only(child => child.type === 'tableCell' || child.type === 'tableHeader')) invalid('table rows may only contain cells');
      break;
  }
  return output;
}

/** Tracks span occupancy in one row, avoiding a rows-by-columns allocation. */
function validateTable(rows: JSONContent[]): void {
  const occupiedUntil: number[] = [];
  let width: number | undefined;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    let column = 0;
    for (const cell of rows[rowIndex].content ?? []) {
      while ((occupiedUntil[column] ?? 0) > rowIndex) column++;
      const colspan = (cell.attrs?.colspan ?? 1) as number;
      const rowspan = (cell.attrs?.rowspan ?? 1) as number;
      if (column + colspan > MAX_TABLE_COLUMNS || rowIndex + rowspan > rows.length) invalid('table span exceeds table bounds');
      for (let offset = 0; offset < colspan; offset++) {
        if ((occupiedUntil[column + offset] ?? 0) > rowIndex) invalid('overlapping table cells');
        occupiedUntil[column + offset] = rowIndex + rowspan;
      }
      column += colspan;
    }
    while ((occupiedUntil[column] ?? 0) > rowIndex) column++;
    if (width === undefined) width = column;
    if (width === 0) invalid('table must contain at least one column');
    if (column !== width || occupiedUntil.length > width) invalid('table is not rectangular');
    for (let i = 0; i < width; i++) if ((occupiedUntil[i] ?? 0) <= rowIndex) invalid('table contains an empty slot');
  }
}

function content(input: unknown, budget: Budget): JSONContent {
  const result = validateNode(input, 1, budget);
  if (result.type !== 'doc') invalid('content root must be doc');
  return result;
}

export function validateContent(input: unknown): JSONContent {
  const result = content(input, newBudget());
  boundedJSON(result);
  return result;
}

function timestamp(value: unknown, label: string, budget: Budget): string {
  const result = string(value, 32, label, budget);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result)) invalid(`${label} must be a UTC ISO timestamp`);
  const date = new Date(result);
  const normalized = result.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) invalid(`${label} is not a valid date`);
  return result;
}

function document(input: unknown, budget: Budget): DocumentRecord {
  const value = object(input, 'document');
  keys(value, ['id', 'title', 'content', 'schemaVersion', 'createdAt', 'updatedAt', 'revision'], 'document');
  if (value.schemaVersion !== 1) invalid('unsupported schema version');
  const id = string(value.id, 200, 'document id', budget);
  if (!id.trim()) invalid('document id must not be empty');
  const title = string(value.title, 200, 'document title', budget);
  const createdAt = timestamp(value.createdAt, 'createdAt', budget);
  const updatedAt = timestamp(value.updatedAt, 'updatedAt', budget);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) invalid('updatedAt precedes createdAt');
  return {
    id, title, content: content(value.content, budget), schemaVersion: 1, createdAt, updatedAt,
    revision: integer(value.revision, 0, Number.MAX_SAFE_INTEGER, 'revision'),
  };
}

export function validateDocument(input: unknown): DocumentRecord {
  const result = document(input, newBudget());
  boundedJSON(result);
  return result;
}

function documents(input: unknown): DocumentRecord[] {
  const budget = newBudget();
  const seen = new Set<string>();
  return array(input, MAX_DOCUMENTS, 'documents').map(value => {
    const result = document(value, budget);
    if (seen.has(result.id)) invalid('duplicate document ids');
    seen.add(result.id);
    return result;
  });
}

export function parseBackup(text: string): DocumentRecord[] {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_BYTES || encoder.encode(text).byteLength > MAX_BACKUP_BYTES) invalid('backup exceeds the byte limit');
  const backup = object(JSON.parse(text), 'backup');
  keys(backup, ['format', 'version', 'documents'], 'backup');
  if (backup.format !== 'document-editor' || backup.version !== 1) invalid('unsupported backup format or version');
  return documents(backup.documents);
}

export function serializeBackup(records: DocumentRecord[]): string {
  return boundedJSON({ format: 'document-editor', version: 1, documents: documents(records) });
}

export function emptyContent(): JSONContent { return { type: 'doc', content: [{ type: 'paragraph' }] }; }

export function sampleContent(): JSONContent {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Selamat datang' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Ini adalah contoh dokumen. Mulailah menulis dan susun ide Anda di sini.' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Catatan penting' }] },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Dokumen disimpan secara lokal di perangkat ini.' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ekspor cadangan secara berkala untuk melindungi pekerjaan Anda.' }] }] },
      ] },
    ],
  };
}

export class ConflictError extends Error {
  constructor(message = 'The document has changed. Reload it before saving or deleting.') {
    super(message);
    this.name = 'ConflictError';
  }
}

export class MissingDocumentError extends Error {
  constructor(message = 'The document no longer exists.') {
    super(message);
    this.name = 'MissingDocumentError';
  }
}

export function createDocumentId(): string {
  const crypto = globalThis.crypto;
  if (!crypto || (typeof crypto.randomUUID !== 'function' && typeof crypto.getRandomValues !== 'function')) {
    throw new Error('Secure random IDs are unavailable.');
  }
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface TransactionContext<T> {
  store: IDBObjectStore;
  result: (value: T) => void;
  request: <V>(request: IDBRequest<V>, success: (value: V) => void) => void;
  fail: (error: unknown) => void;
}

export class DocumentStore {
  private database?: Promise<IDBDatabase>;
  private closed = false;
  private readonly name: string;

  constructor(name = 'document-editor-v1') {
    this.name = name;
  }

  private async open(): Promise<IDBDatabase> {
    if (this.closed) throw new Error('DocumentStore is closed.');
    // Open lazily: a failed constructor must not leave an unobserved rejection.
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        let settled = false;
        let upgradeFailure: unknown;
        const request = globalThis.indexedDB.open(this.name, 1);
        request.onupgradeneeded = () => {
          try {
            if (!request.result.objectStoreNames.contains('documents')) {
              request.result.createObjectStore('documents', { keyPath: 'id' });
            }
          } catch (error) {
            upgradeFailure = error;
            request.transaction?.abort();
          }
        };
        request.onerror = () => { settled = true; reject(upgradeFailure ?? request.error ?? new Error('Failed to open document storage.')); };
        request.onblocked = () => { settled = true; reject(new Error('Document storage upgrade is blocked by another connection.')); };
        request.onsuccess = () => {
          const db = request.result;
          if (settled) { db.close(); return; }
          db.onversionchange = () => db.close();
          settled = true;
          resolve(db);
        };
      });
    }
    const db = await this.database;
    if (this.closed) throw new Error('DocumentStore is closed.');
    return db;
  }

  private async transaction<T>(mode: IDBTransactionMode, action: (context: TransactionContext<T>) => void): Promise<T> {
    const db = await this.open();
    // One promise owns both request failures and transaction completion. Errors
    // reject only after abort, so a caller never observes a partial import.
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('documents', mode);
      let output: T;
      let failure: unknown;
      const fail = (error: unknown): void => {
        failure ??= error;
        try { transaction.abort(); } catch { reject(failure); }
      };
      transaction.oncomplete = () => resolve(output);
      transaction.onabort = () => reject(failure ?? transaction.error ?? new DOMException('Document transaction aborted.', 'AbortError'));
      transaction.onerror = event => {
        const request = event.target as IDBRequest;
        failure ??= request.error ?? transaction.error;
      };
      const context: TransactionContext<T> = {
        store: transaction.objectStore('documents'),
        result: value => { output = value; },
        fail,
        request: (request, success) => {
          request.onerror = () => { failure ??= request.error; };
          request.onsuccess = () => {
            try { success(request.result); } catch (error) { fail(error); }
          };
        },
      };
      try { action(context); } catch (error) { fail(error); }
    });
  }

  async list(): Promise<DocumentRecord[]> {
    return this.transaction('readonly', context => {
      context.request(context.store.getAll(), values => context.result(values.map(value => validateDocument(value))));
    });
  }

  async get(id: string): Promise<DocumentRecord | undefined> {
    string(id, 200, 'document id');
    return this.transaction('readonly', context => {
      context.request(context.store.get(id), value => context.result(value === undefined ? undefined : validateDocument(value)));
    });
  }

  async create(record: DocumentRecord): Promise<DocumentRecord> {
    const validated = validateDocument(record);
    return this.transaction('readwrite', context => {
      context.request(context.store.add(validated), () => context.result(validated));
    });
  }

  async save(record: DocumentRecord, expectedRevision: number): Promise<DocumentRecord> {
    const validated = validateDocument(record);
    integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expected revision');
    return this.transaction('readwrite', context => {
      context.request(context.store.get(validated.id), value => {
        if (value === undefined) throw new MissingDocumentError();
        const current = validateDocument(value);
        if (current.revision !== expectedRevision) throw new ConflictError();
        const saved = validateDocument({
          ...validated, createdAt: current.createdAt,
          updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt))).toISOString(),
          revision: current.revision + 1,
        });
        context.request(context.store.put(saved), () => context.result(saved));
      });
    });
  }

  async delete(id: string, expectedRevision: number): Promise<void> {
    string(id, 200, 'document id');
    integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expected revision');
    return this.transaction('readwrite', context => {
      context.request(context.store.get(id), value => {
        if (value === undefined) throw new MissingDocumentError();
        if (validateDocument(value).revision !== expectedRevision) throw new ConflictError();
        context.request(context.store.delete(id), () => context.result(undefined));
      });
    });
  }

  async importDocuments(records: DocumentRecord[]): Promise<DocumentRecord[]> {
    const validated = documents(records);
    boundedJSON({ format: 'document-editor', version: 1, documents: validated });
    const forbidden = new Set(validated.map(record => record.id));
    const now = new Date().toISOString();
    const imported = validated.map(record => {
      let id = createDocumentId();
      let attempts = 0;
      while (forbidden.has(id)) {
        if (++attempts >= 10) throw new Error('Unable to generate a unique document ID.');
        id = createDocumentId();
      }
      forbidden.add(id);
      return validateDocument({ ...record, id, createdAt: now, updatedAt: now, revision: 0 });
    });
    boundedJSON({ format: 'document-editor', version: 1, documents: imported });
    return this.transaction('readwrite', context => {
      for (const record of imported) context.request(context.store.add(record), () => undefined);
      context.result(imported);
    });
  }

  async seedIfEmpty(): Promise<void> {
    return this.transaction('readwrite', context => {
      context.request(context.store.count(), count => {
        if (count !== 0) { context.result(undefined); return; }
        const now = new Date().toISOString();
        const sample = validateDocument({
          id: createDocumentId(), title: 'Dokumen contoh', content: sampleContent(), schemaVersion: 1,
          createdAt: now, updatedAt: now, revision: 0,
        });
        context.request(context.store.add(sample), () => context.result(undefined));
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.database) (await this.database).close();
  }
}
