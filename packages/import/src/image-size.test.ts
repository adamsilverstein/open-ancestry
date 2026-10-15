import { describe, expect, it } from 'vitest';
import { imageSize } from './image-size';

const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

describe('imageSize', () => {
  it('reads PNG', () => {
    const png = bytes(
      [0x89, ...ascii('PNG\r\n\x1a\n')],
      u32be(13),
      ascii('IHDR'),
      u32be(300),
      u32be(200),
      [8, 2, 0, 0, 0],
    );
    expect(imageSize(png)).toEqual({ width: 300, height: 200 });
  });

  it('reads GIF', () => {
    expect(imageSize(bytes(ascii('GIF89a'), u16le(40), u16le(30), [0, 0, 0]))).toEqual({
      width: 40,
      height: 30,
    });
  });

  it('reads JPEG from the first frame header, skipping other segments', () => {
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
    const sof0 = [0xff, 0xc0, 0x00, 0x0b, 8, 0x01, 0x2c, 0x00, 0xc8, 3, 0, 0, 0, 0, 0];
    // Height 0x012c = 300 then width 0x00c8 = 200 (SOF stores height first).
    expect(imageSize(bytes([0xff, 0xd8], app0, sof0))).toEqual({ width: 200, height: 300 });
  });

  it('does not take a DHT marker (C4) for a frame header', () => {
    const dht = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00];
    const sof2 = [0xff, 0xc2, 0x00, 0x0b, 8, 0x00, 0x10, 0x00, 0x20, 3, 0, 0, 0, 0, 0];
    expect(imageSize(bytes([0xff, 0xd8], dht, sof2))).toEqual({ width: 32, height: 16 });
  });

  it('reads WebP (lossy, lossless and extended)', () => {
    const riff = (chunk: number[]) => bytes(ascii('RIFF'), [0, 0, 0, 0], ascii('WEBP'), chunk);
    const vp8 = [
      ...ascii('VP8 '),
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0x9d,
      0x01,
      0x2a,
      ...u16le(300),
      ...u16le(200),
    ];
    expect(imageSize(riff(vp8))).toEqual({ width: 300, height: 200 });
    // VP8L: 14-bit width-1 and height-1 packed after the 0x2f signature.
    const w = 299,
      h = 199;
    const bits = w | (h << 14);
    const vp8l = [
      ...ascii('VP8L'),
      0,
      0,
      0,
      0,
      0x2f,
      bits & 255,
      (bits >>> 8) & 255,
      (bits >>> 16) & 255,
      (bits >>> 24) & 255,
    ];
    expect(imageSize(riff(vp8l))).toEqual({ width: 300, height: 200 });
    const vp8x = [...ascii('VP8X'), 0, 0, 0, 0, 0, 0, 0, 0, ...u24le(299), ...u24le(199)];
    expect(imageSize(riff(vp8x))).toEqual({ width: 300, height: 200 });
  });

  it('returns undefined for anything else or truncated input', () => {
    expect(imageSize(new TextEncoder().encode('these bytes are not an image'))).toBeUndefined();
    expect(imageSize(new Uint8Array([0x89, 0x50]))).toBeUndefined();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeUndefined();
  });
});
