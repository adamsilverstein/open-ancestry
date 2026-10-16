/*
 * Embedded metadata removed from photos in a privatized export (#263): EXIF
 * (an artist, a caption, GPS), XMP, IPTC, JPEG comments and PNG text can name
 * a living person or place them. Each stripper takes a file in pieces, as it
 * is read, and returns the bytes to write, so a large file is never held
 * whole. Each format keeps an allowlist of what a decoder needs to show the
 * image as before: JFIF, a real ICC profile, Adobe's colour transform and
 * the Orientation tag (JPEG); image, colour and animation chunks (PNG, WebP).
 * Stripping costs little next to deflate and disk: a 19.5 MB JPEG in 64 KiB
 * pieces took 8.5 ms (review of #286).
 */

import { crc32 } from 'node:zlib';

/** Photo formats whose metadata can be removed; anything else is left out of a privatized export. */
export type StripKind = 'jpeg' | 'png' | 'webp';

/** Bytes needed to recognize a format. */
export const SNIFF_BYTES = 12;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (bytes: Uint8Array, at: number, text: string) =>
  text.split('').every((c, i) => bytes[at + i] === c.charCodeAt(0));

/** The format of a file from its first bytes, if its metadata can be removed. */
export function strippableKind(head: Uint8Array): StripKind | undefined {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (PNG_SIGNATURE.every((b, i) => head[i] === b)) return 'png';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'webp';
  return undefined;
}

/** A file that is not the format it claimed to be, or is cut short. */
export class StripError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripError';
  }
}

/** Takes a file in pieces and returns the bytes to write for each; `end` checks it was whole. */
export interface Stripper {
  push(chunk: Uint8Array): Uint8Array;
  end(): Uint8Array;
}

const join = (parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * The shared machinery: bytes not yet decided wait in `pending`; a format's
 * `step` decides what the front of the bytes is, consuming some, starting a
 * run of bytes to copy or drop, or asking to wait for more. Output may be a
 * view of the caller's bytes: copy it before reusing them.
 */
abstract class StreamStripper implements Stripper {
  private pending = new Uint8Array(0);
  protected out: Uint8Array[] = [];
  /** Bytes still to copy (positive) or drop (negative) before the next decision. */
  protected run = 0;

  push(chunk: Uint8Array): Uint8Array {
    let buf = this.pending.length ? join([this.pending, chunk]) : chunk;
    for (;;) {
      if (this.run !== 0 && buf.length) {
        const n = Math.min(Math.abs(this.run), buf.length);
        if (this.run > 0) this.out.push(buf.subarray(0, n));
        this.run += this.run > 0 ? -n : n;
        buf = buf.subarray(n);
        continue;
      }
      if (!buf.length) break;
      const used = this.step(buf);
      if (used === null) break;
      buf = buf.subarray(used);
    }
    // A copy: the caller may reuse the buffer it passed (and Buffer#slice is only a view).
    this.pending = new Uint8Array(buf);
    const out = join(this.out.length ? this.out : [new Uint8Array(0)]);
    this.out = [];
    return out;
  }

  end(): Uint8Array {
    if (this.pending.length || this.run !== 0 || !this.complete()) {
      throw new StripError('the file ended in the middle of a segment');
    }
    return new Uint8Array(0);
  }

  /** Handles the front of `buf`: returns the bytes it consumed (maybe 0, having started a run or changed state), or null to wait for more. */
  protected abstract step(buf: Uint8Array): number | null;
  protected abstract complete(): boolean;
  /** Copies `n` bytes through, starting with what `buf` already holds. */
  protected keep(n: number): void {
    this.run = n;
  }
  /** Drops `n` bytes. */
  protected drop(n: number): void {
    this.run = -n;
  }
}

/** Bytes of a segment's data read to decide on it: identifiers, and an ICC profile's signature. */
const JPEG_ID_BYTES = 54;
/** Where an ICC profile's `acsp` signature sits in its first APP2 (12 identifier + 2 sequence bytes + 36). */
const ICC_SIGNATURE_AT = 14 + 36;

/** The EXIF Orientation (2-8) in an APP1 `Exif` segment's data, if it is not upright (1) or absent. */
function exifOrientation(data: Uint8Array): number | undefined {
  if (!ascii(data, 0, 'Exif\0\0') || data.length < 14) return undefined;
  const tiff = data.subarray(6);
  const little = ascii(tiff, 0, 'II');
  if (!little && !ascii(tiff, 0, 'MM')) return undefined;
  const u16 = (at: number) =>
    little ? tiff[at]! | (tiff[at + 1]! << 8) : (tiff[at]! << 8) | tiff[at + 1]!;
  const u32 = (at: number) =>
    little
      ? (tiff[at]! | (tiff[at + 1]! << 8) | (tiff[at + 2]! << 16) | (tiff[at + 3]! << 24)) >>> 0
      : ((tiff[at]! << 24) | (tiff[at + 1]! << 16) | (tiff[at + 2]! << 8) | tiff[at + 3]!) >>> 0;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return undefined;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3) {
      const value = u16(entry + 8);
      return value >= 2 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

/** A minimal APP1 EXIF segment holding only an Orientation tag (big-endian TIFF, one IFD entry). */
function orientationSegment(orientation: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xe1,
    0x00,
    0x22, // APP1, length 34
    ...[0x45, 0x78, 0x69, 0x66, 0x00, 0x00], // "Exif\0\0"
    ...[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], // "MM", 42, IFD0 at 8
    0x00,
    0x01, // one entry
    ...[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00],
    ...[0x00, 0x00, 0x00, 0x00], // no next IFD
  ]);
}

class JpegStripper extends StreamStripper {
  private state: 'soi' | 'marker' | 'entropy' | 'done' = 'soi';
  /** Whether the ICC profile's first APP2 had a real profile signature; later parts follow it. */
  private iccValid = false;

  /**
   * Segments to keep: what changes how the image looks, never who took it.
   * Not APPn or COM (tables, frame, scan) is kept; of APPn, JFIF, a real ICC
   * profile and Adobe's colour transform.
   */
  private keepSegment(marker: number, data: Uint8Array): boolean {
    if (marker === 0xfe) return false; // COM
    if (marker < 0xe0 || marker > 0xef) return true;
    if (marker === 0xe0) return ascii(data, 0, 'JFIF\0') || ascii(data, 0, 'JFXX\0');
    if (marker === 0xe2 && ascii(data, 0, 'ICC_PROFILE\0')) {
      // A profile may span several APP2s; the first carries its signature.
      if (data[12] === 1) this.iccValid = ascii(data, ICC_SIGNATURE_AT, 'acsp');
      return this.iccValid;
    }
    if (marker === 0xee) return ascii(data, 0, 'Adobe');
    return false; // EXIF and XMP (APP1), IPTC (APP13), maker data, C2PA (APP11)
  }

  protected step(buf: Uint8Array): number | null {
    switch (this.state) {
      case 'soi':
        if (buf.length < 2) return null;
        if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new StripError('not a JPEG');
        this.out.push(buf.subarray(0, 2));
        this.state = 'marker';
        return 2;
      case 'done':
        // Anything after EOI is no part of the image (and can be anything).
        return buf.length;
      case 'entropy': {
        // Scan data: copy up to a marker. FF 00 is a stuffed byte, FF D0-D7 a restart.
        let at = 0;
        for (;;) {
          const ff = buf.indexOf(0xff, at);
          if (ff < 0) {
            this.out.push(buf);
            return buf.length;
          }
          if (ff + 1 >= buf.length) {
            this.out.push(buf.subarray(0, ff));
            return ff || null;
          }
          const next = buf[ff + 1]!;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            at = ff + (next === 0xff ? 1 : 2);
            continue;
          }
          this.out.push(buf.subarray(0, ff));
          this.state = 'marker';
          return ff;
        }
      }
      case 'marker': {
        if (!buf.length) return null;
        if (buf[0] !== 0xff) {
          // Stray bytes outside any segment: decoders skip them, and so does this.
          const ff = buf.indexOf(0xff);
          return ff < 0 ? buf.length : ff;
        }
        if (buf.length < 2) return null;
        const marker = buf[1]!;
        if (marker === 0xff) return 1; // fill byte
        if (marker === 0xd9) {
          this.out.push(buf.subarray(0, 2));
          this.state = 'done';
          return 2;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          this.out.push(buf.subarray(0, 2));
          return 2;
        }
        if (buf.length < 4) return null;
        const length = (buf[2]! << 8) | buf[3]!;
        if (length < 2) throw new StripError('a JPEG segment has a bad length');
        const total = 2 + length;
        const idBytes = Math.min(length - 2, JPEG_ID_BYTES);
        if (buf.length < 4 + idBytes) return null;
        if (marker === 0xe1 && ascii(buf, 4, 'Exif\0\0')) {
          // EXIF goes, but its Orientation stays, or portrait photos turn sideways.
          // The whole segment (at most 64 KiB) is read to find it.
          if (buf.length < total) return null;
          const orientation = exifOrientation(buf.subarray(4, total));
          if (orientation) this.out.push(orientationSegment(orientation));
          return total;
        }
        if (this.keepSegment(marker, buf.subarray(4, 4 + idBytes))) this.keep(total);
        else this.drop(total);
        if (marker === 0xda) this.state = 'entropy';
        return 0;
      }
    }
  }

  protected complete(): boolean {
    return this.state === 'done';
  }
}

/**
 * PNG chunks kept: image data, colour and layout, and APNG animation. Any
 * other chunk (text, EXIF, C2PA `caBX`, timestamps, private chunks) goes.
 */
const PNG_KEEP = new Set(
  'IHDR PLTE IDAT IEND tRNS gAMA cHRM sRGB iCCP sBIT bKGD pHYs cICP mDCV cLLI acTL fcTL fdAT'.split(
    ' ',
  ),
);

/**
 * The sizes the PNG specification allows for fixed-size chunks: one of
 * another size could carry anything, so it is dropped.
 */
const PNG_SIZES: Record<string, readonly number[]> = {
  IHDR: [13],
  gAMA: [4],
  cHRM: [32],
  sRGB: [1],
  pHYs: [9],
  sBIT: [1, 2, 3, 4],
  bKGD: [1, 2, 6],
  cICP: [4],
  mDCV: [24],
  cLLI: [8],
  acTL: [8],
  fcTL: [26],
  IEND: [0],
};

/** What iCCP's free-text profile name becomes (#286 review). */
const ICC_NAME = 'ICC Profile';

/** An iCCP chunk with its profile name replaced, and its CRC recomputed. */
function renamedIccp(chunk: Uint8Array): Uint8Array | undefined {
  const data = chunk.subarray(8, chunk.length - 4);
  const nul = data.indexOf(0);
  if (nul < 1 || nul > 79) return undefined;
  const rest = data.subarray(nul);
  const out = new Uint8Array(12 + ICC_NAME.length + rest.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, ICC_NAME.length + rest.length);
  out.set(chunk.subarray(4, 8), 4);
  for (let i = 0; i < ICC_NAME.length; i++) out[8 + i] = ICC_NAME.charCodeAt(i);
  out.set(rest, 8 + ICC_NAME.length);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

class PngStripper extends StreamStripper {
  private state: 'signature' | 'chunk' | 'done' = 'signature';

  protected step(buf: Uint8Array): number | null {
    if (this.state === 'done') return buf.length;
    if (this.state === 'signature') {
      if (buf.length < 8) return null;
      if (!PNG_SIGNATURE.every((b, i) => buf[i] === b)) throw new StripError('not a PNG');
      this.out.push(buf.subarray(0, 8));
      this.state = 'chunk';
      return 8;
    }
    if (buf.length < 8) return null;
    const length = ((buf[0]! << 24) >>> 0) + (buf[1]! << 16) + (buf[2]! << 8) + buf[3]!;
    const type = String.fromCharCode(buf[4]!, buf[5]!, buf[6]!, buf[7]!);
    const total = 12 + length;
    const sizes = PNG_SIZES[type];
    if (!PNG_KEEP.has(type) || (sizes && !sizes.includes(length))) {
      this.drop(total);
    } else if (type === 'iCCP') {
      // Read whole (a compressed profile, small) to give it a fixed name.
      if (buf.length < total) return null;
      const renamed = renamedIccp(buf.subarray(0, total));
      if (renamed) this.out.push(renamed);
      return total;
    } else {
      this.keep(total);
    }
    if (type === 'IEND') this.state = 'done';
    return 0;
  }

  protected complete(): boolean {
    return this.state === 'done';
  }
}

/**
 * WebP chunks kept: image data, alpha, animation and the ICC profile. Any
 * other chunk (EXIF, XMP, C2PA, unknown) goes; VP8X's EXIF and XMP flags are
 * cleared.
 */
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
const dropsWebpChunk = (type: string) => !WEBP_KEEP.has(type);
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

const readU32LE = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

/**
 * Bytes the WebP stripper will drop, from the chunk headers alone, so the
 * RIFF size at the start can be written right. `readAt` reads `length` bytes
 * at `position` (fewer at the end of the file).
 */
export async function webpRemovedBytes(
  readAt: (position: number, length: number) => Promise<Uint8Array>,
): Promise<number> {
  const header = await readAt(0, 12);
  if (header.length < 12 || !ascii(header, 0, 'RIFF') || !ascii(header, 8, 'WEBP')) {
    throw new StripError('not a WebP');
  }
  const end = 8 + readU32LE(header, 4);
  let removed = 0;
  for (let at = 12; at + 8 <= end;) {
    const chunk = await readAt(at, 8);
    if (chunk.length < 8) break;
    const type = String.fromCharCode(...chunk.subarray(0, 4));
    const total = 8 + readU32LE(chunk, 4) + (readU32LE(chunk, 4) & 1);
    if (dropsWebpChunk(type)) removed += total;
    at += total;
  }
  return removed;
}

class WebpStripper extends StreamStripper {
  private state: 'header' | 'chunk' | 'done' = 'header';
  /** Bytes left in the RIFF container after the header. */
  private left = 0;

  private readonly removed: number;

  constructor(removed: number) {
    super();
    this.removed = removed;
  }

  protected step(buf: Uint8Array): number | null {
    if (this.state === 'done') return buf.length;
    if (this.state === 'header') {
      if (buf.length < 12) return null;
      if (!ascii(buf, 0, 'RIFF') || !ascii(buf, 8, 'WEBP')) throw new StripError('not a WebP');
      const size = readU32LE(buf, 4);
      const header = new Uint8Array(buf.subarray(0, 12));
      new DataView(header.buffer).setUint32(4, size - this.removed, true);
      this.out.push(header);
      this.left = size - 4;
      this.state = this.left > 0 ? 'chunk' : 'done';
      return 12;
    }
    if (buf.length < 8) return null;
    const type = String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!);
    const size = readU32LE(buf, 4);
    const total = 8 + size + (size & 1);
    if (type === 'VP8X' && buf.length < 9) return null;
    this.left -= total;
    if (this.left <= 0) this.state = 'done';
    if (dropsWebpChunk(type)) {
      this.drop(total);
      return 0;
    }
    if (type === 'VP8X') {
      const head = new Uint8Array(buf.subarray(0, 9));
      head[8] = head[8]! & ~(VP8X_EXIF | VP8X_XMP);
      this.out.push(head);
      this.keep(total - 9);
      return 9;
    }
    this.keep(total);
    return 0;
  }

  protected complete(): boolean {
    return this.state === 'done' && this.left >= 0;
  }
}

/** A stripper for `kind`; a WebP needs the bytes its EXIF and XMP chunks take (`webpRemovedBytes`). */
export function createStripper(kind: StripKind, webpRemoved = 0): Stripper {
  if (kind === 'jpeg') return new JpegStripper();
  if (kind === 'png') return new PngStripper();
  return new WebpStripper(webpRemoved);
}

/** Strips a whole file held in memory. */
export function stripBytes(kind: StripKind, bytes: Uint8Array): Uint8Array {
  let removed = 0;
  if (kind === 'webp') {
    // Synchronous walk of the same chunk headers as webpRemovedBytes.
    const end = Math.min(bytes.length, 8 + readU32LE(bytes, 4));
    for (let at = 12; at + 8 <= end;) {
      const size = readU32LE(bytes, at + 4);
      const total = 8 + size + (size & 1);
      if (dropsWebpChunk(String.fromCharCode(...bytes.subarray(at, at + 4)))) removed += total;
      at += total;
    }
  }
  const stripper = createStripper(kind, removed);
  const out = stripper.push(bytes);
  stripper.end();
  return out;
}
