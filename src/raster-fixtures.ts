/** Genuine one-pixel raster fixtures. This module is for tests only. */
export type RasterFormat = 'png' | 'jpeg' | 'gif' | 'webp';

const payloads: Record<RasterFormat, string> = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQSFgAAAHEASFiX4r9AAAAAElFTkSuQmCC',
  jpeg: '/9j//gAQTGF2YzYyLjI4LjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAAAAYQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAABAAEDARIAAhIAAxIA/9oADAMBAAIRAxEAPwCTFUJkf//Z',
  gif: 'R0lGODdhAQABAIEAACBgoAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==',
  webp: 'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQsIIUtP+BiOh/AAA=',
};

export function rasterFixture(format: RasterFormat): string {
  return `data:image/${format};base64,${payloads[format]}`;
}

export const TINY_PNG = rasterFixture('png');

export function rasterBytes(format: RasterFormat): Uint8Array {
  return Uint8Array.from(atob(payloads[format]), character => character.charCodeAt(0));
}

export function rasterDataUrl(format: RasterFormat, bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:image/${format};base64,${btoa(binary)}`;
}

/** Computes PNG's CRC-32 over a chunk type and its data. */
export function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Inserts a private ancillary chunk before IEND, preserving actual PNG decoding. */
export function paddedPng(bytes: number): string {
  return pngDataUrl({ byteLength: bytes });
}

/**
 * Pads a genuine PNG to an exact decoded byte length. Dimension overrides alter
 * IHDR only and are intended for header validation tests, not decoding tests.
 */
export function pngDataUrl(options: { byteLength?: number; width?: number; height?: number } = {}): string {
  const source = rasterBytes('png');
  const length = options.byteLength ?? source.length;
  if (!Number.isSafeInteger(length) || length < source.length || (length > source.length && length < source.length + 12)) {
    throw new RangeError(`PNG byteLength must be ${source.length} or at least ${source.length + 12}.`);
  }
  for (const dimension of [options.width, options.height]) {
    if (dimension !== undefined && (!Number.isInteger(dimension) || dimension < 0 || dimension > 0xffffffff)) {
      throw new RangeError('PNG dimensions must be unsigned 32-bit integers.');
    }
  }
  const output = new Uint8Array(length);
  const end = source.length - 12;
  output.set(source.subarray(0, end));
  output.set(source.subarray(end), length - 12);
  const view = new DataView(output.buffer);
  if (options.width !== undefined) view.setUint32(16, options.width);
  if (options.height !== undefined) view.setUint32(20, options.height);
  view.setUint32(29, pngCrc(output.subarray(12, 29)));
  if (length > source.length) {
    const chunkLength = length - source.length - 12;
    view.setUint32(end, chunkLength);
    output.set([0x70, 0x61, 0x44, 0x64], end + 4); // paDd: private, ancillary, safe-to-copy.
    view.setUint32(length - 16, pngCrc(output.subarray(end + 4, length - 16)));
  }
  return rasterDataUrl('png', output);
}
