/**
 * Pixel size of a PNG, GIF, JPEG or WebP from its header, without decoding
 * it; undefined for other formats or truncated files. The import records it
 * so clients can choose thumbnail sizes up front.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (n: number) => bytes.length >= n;
  const ascii = (at: number, text: string) =>
    has(at + text.length) && [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));
  const size = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : undefined;

  if (bytes[0] === 0x89 && ascii(1, 'PNG') && ascii(12, 'IHDR') && has(24)) {
    return size(view.getUint32(16), view.getUint32(20));
  }
  if ((ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) && has(10)) {
    return size(view.getUint16(6, true), view.getUint16(8, true));
  }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return webpSize(bytes, view, ascii, size);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes, view, size);
  return undefined;
}

type Size = (width: number, height: number) => { width: number; height: number } | undefined;

function webpSize(
  bytes: Uint8Array,
  view: DataView,
  ascii: (at: number, text: string) => boolean,
  size: Size,
) {
  if (ascii(12, 'VP8 ') && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01) {
    return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  }
  if (ascii(12, 'VP8L') && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = view.getUint32(21, true);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (ascii(12, 'VP8X') && bytes.length >= 30) {
    const u24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
    return size(u24(24) + 1, u24(27) + 1);
  }
  return undefined;
}

/** Start-of-frame markers: C0-CF except DHT (C4), JPG (C8) and DAC (CC). */
const isFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpegSize(bytes: Uint8Array, view: DataView, size: Size) {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    // Fill bytes, and markers without a length (RST, SOI, TEM).
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = view.getUint16(at + 2);
    if (length < 2) return undefined;
    if (isFrame(marker)) {
      if (at + 9 > bytes.length) return undefined;
      return size(view.getUint16(at + 7), view.getUint16(at + 5));
    }
    at += 2 + length;
  }
  return undefined;
}
