import { strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { GedzipError, readGedzip } from './gedzip';

const GED = strToU8('0 HEAD\n1 GEDC\n2 VERS 7.0\n0 TRLR\n');
const zip = (files: Zippable, level: 0 | 9 = 9) => zipSync(files, { level });

function expectError(fn: () => unknown, code: GedzipError['code']) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GedzipError);
    expect((error as GedzipError).code).toBe(code);
    return;
  }
  throw new Error('expected GedzipError');
}

describe('readGedzip', () => {
  it('reads gedcom.ged and media entries', () => {
    const photo = new Uint8Array([1, 2, 3, 4]);
    const result = readGedzip(zip({ 'gedcom.ged': GED, media: { 'photo.jpg': photo } }));
    expect(result.gedcomPath).toBe('gedcom.ged');
    expect(result.gedcom).toEqual(GED);
    expect([...result.media.keys()]).toEqual(['media/photo.jpg']);
    expect(result.media.get('media/photo.jpg')).toEqual(photo);
    expect(result.warnings).toEqual([]);
  });

  it('falls back to a single .ged file at the root with a warning', () => {
    const result = readGedzip(zip({ 'Family.GED': GED }));
    expect(result.gedcomPath).toBe('Family.GED');
    expect(result.warnings[0]).toMatch(/gedcom\.ged/);
  });

  it('rejects archives without a GEDCOM file', () => {
    expectError(() => readGedzip(zip({ 'photo.jpg': new Uint8Array([1]) })), 'no-gedcom');
    expectError(() => readGedzip(zip({ 'a.ged': GED, 'b.ged': GED })), 'no-gedcom');
  });

  it('skips path traversal, absolute paths and drive letters with warnings', () => {
    const result = readGedzip(
      zip({
        'gedcom.ged': GED,
        '../evil.jpg': new Uint8Array([1]),
        '/etc/passwd': new Uint8Array([1]),
        'C:/windows.jpg': new Uint8Array([1]),
        'media\\..\\..\\x.jpg': new Uint8Array([1]),
        'ok/../../y.jpg': new Uint8Array([1]),
      }),
    );
    expect(result.media.size).toBe(0);
    expect(result.warnings).toHaveLength(5);
  });

  it('ignores directory entries and normalizes ./ segments', () => {
    const result = readGedzip(
      zip({
        'gedcom.ged': GED,
        'media/': new Uint8Array(),
        './media/./a.jpg': new Uint8Array([1]),
      }),
    );
    expect([...result.media.keys()]).toEqual(['media/a.jpg']);
  });

  it('enforces the per-entry size limit', () => {
    const big = new Uint8Array(10_000).fill(7);
    expectError(
      () => readGedzip(zip({ 'gedcom.ged': GED, 'big.bin': big }), { maxEntrySize: 5000 }),
      'too-large',
    );
  });

  it('enforces the entry count limit', () => {
    const files: Zippable = { 'gedcom.ged': GED };
    for (let i = 0; i < 5; i++) files[`m${i}.jpg`] = new Uint8Array([i]);
    expectError(() => readGedzip(zip(files), { maxEntries: 3 }), 'too-many-entries');
  });

  it('enforces the total uncompressed size limit', () => {
    const big = new Uint8Array(10_000).fill(7);
    expectError(
      () => readGedzip(zip({ 'gedcom.ged': GED, 'big.bin': big }, 0), { maxTotalSize: 5000 }),
      'too-large',
    );
  });

  it('rejects zip bombs by compression ratio', () => {
    const zeros = new Uint8Array(2_000_000);
    expectError(() => readGedzip(zip({ 'gedcom.ged': GED, 'bomb.bin': zeros })), 'ratio');
  });

  it('can skip media decompression', () => {
    const result = readGedzip(zip({ 'gedcom.ged': GED, 'a.jpg': new Uint8Array([1]) }), {
      includeMedia: false,
    });
    expect(result.media.size).toBe(0);
    expect(result.mediaPaths).toEqual(['a.jpg']);
  });

  it('rejects bytes that are not a zip archive', () => {
    expectError(() => readGedzip(GED), 'invalid');
  });
});
