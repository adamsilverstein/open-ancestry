import { strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { GedzipError, readGedzip } from './gedzip';

const GED = strToU8('0 HEAD\n1 GEDC\n2 VERS 7.0\n0 TRLR\n');
const zip = (files: Zippable, level: 0 | 9 = 9) => zipSync(files, { level });

/** Overwrites a field of the named entry's central directory record (offsets per the zip spec). */
function patchCentral(archive: Uint8Array, name: string, offset: number, value: number, bytes = 4) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let p = 0; p + 46 < archive.length; p++) {
    if (view.getUint32(p, true) !== 0x02014b50) continue;
    const length = view.getUint16(p + 28, true);
    if (new TextDecoder().decode(archive.subarray(p + 46, p + 46 + length)) !== name) continue;
    if (bytes === 4) view.setUint32(p + offset, value, true);
    else view.setUint16(p + offset, value, true);
    return archive;
  }
  throw new Error(`no central entry ${name}`);
}

/** Renames an entry in the central directory (same length names only). */
function renameCentral(archive: Uint8Array, from: string, to: string) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let p = 0; p + 46 < archive.length; p++) {
    if (view.getUint32(p, true) !== 0x02014b50) continue;
    const length = view.getUint16(p + 28, true);
    if (new TextDecoder().decode(archive.subarray(p + 46, p + 46 + length)) !== from) continue;
    archive.set(new TextEncoder().encode(to), p + 46);
    return;
  }
  throw new Error(`no central entry ${from}`);
}

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

  it('rejects many small high-ratio entries by the aggregate ratio', () => {
    // Each entry is under the 1 MiB per-entry ratio threshold; together they are a bomb.
    const files: Zippable = { 'gedcom.ged': GED };
    for (let i = 0; i < 20; i++) files[`z${i}.bin`] = new Uint8Array(512 * 1024);
    expectError(() => readGedzip(zip(files)), 'ratio');
  });

  it('aborts mid-inflation when the running ratio passes the limit', () => {
    // Overall ratio is fine thanks to the incompressible tail, but the first
    // entries inflate ~1000:1, so inflation stops before reaching it.
    const noise = new Uint8Array(4_000_000).map((_, i) => (i * 2654435761) >>> 24);
    const archive = zip({
      'gedcom.ged': new Uint8Array(900 * 1024),
      'a.bin': new Uint8Array(900 * 1024),
      'b.bin': noise,
    });
    expectError(() => readGedzip(archive), 'ratio');
  });

  it('caps the GEDCOM entry separately', () => {
    expectError(() => readGedzip(zip({ 'gedcom.ged': GED }), { maxGedcomSize: 10 }), 'too-large');
  });

  it('warns about and skips case-insensitive and exact duplicate names, keeping the first', () => {
    const archive = zip({
      'gedcom.ged': GED,
      'Photo.jpg': new Uint8Array([1]),
      'photo.jpg': new Uint8Array([2]),
      'other.jpg': new Uint8Array([3]),
    });
    renameCentral(archive, 'other.jpg', 'Photo.jpg');
    const result = readGedzip(archive);
    expect([...result.media]).toEqual([['Photo.jpg', new Uint8Array([1])]]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/ignoring case/);
    expect(result.warnings[1]).toMatch(/duplicate/);
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

  describe('headers that lie about sizes', () => {
    const SIZE = 24;
    const COMPRESSED = 20;

    it('aborts inflation as soon as an entry passes its declared size', () => {
      // 50 MB of zeros declared as 100 bytes passes the up-front checks.
      const archive = zip({ 'gedcom.ged': GED, 'bomb.bin': new Uint8Array(50_000_000) });
      patchCentral(archive, 'bomb.bin', SIZE, 100);
      const start = performance.now();
      expectError(() => readGedzip(archive), 'invalid');
      expect(performance.now() - start).toBeLessThan(1000);
    });

    it('rejects an entry that inflates to less than declared', () => {
      const archive = patchCentral(zip({ 'gedcom.ged': GED }), 'gedcom.ged', SIZE, GED.length + 5);
      expectError(() => readGedzip(archive), 'invalid');
    });

    it('rejects a stored entry whose size does not match', () => {
      const archive = patchCentral(zip({ 'gedcom.ged': GED }, 0), 'gedcom.ged', SIZE, 3);
      expectError(() => readGedzip(archive), 'invalid');
    });

    it('rejects compressed data that runs past the end of the archive', () => {
      const archive = patchCentral(zip({ 'gedcom.ged': GED }), 'gedcom.ged', COMPRESSED, 1_000_000);
      expectError(() => readGedzip(archive), 'invalid');
    });

    it('rejects corrupt deflate data', () => {
      const archive = zip({ 'gedcom.ged': GED });
      // Local header (30) + name (10) is where the deflate stream starts.
      archive.fill(0xff, 40, 44);
      expectError(() => readGedzip(archive), 'invalid');
    });

    it('rejects a local header offset that does not point at a local header', () => {
      const archive = patchCentral(zip({ 'gedcom.ged': GED }), 'gedcom.ged', 42, 5);
      expectError(() => readGedzip(archive), 'invalid');
    });

    it('rejects ZIP64 markers', () => {
      const archive = patchCentral(zip({ 'gedcom.ged': GED }), 'gedcom.ged', SIZE, 0xffffffff);
      expectError(() => readGedzip(archive), 'invalid');
    });

    it('skips encrypted entries and unknown compression methods', () => {
      const archive = zip({
        'gedcom.ged': GED,
        'a.jpg': new Uint8Array([1]),
        'b.jpg': new Uint8Array([2]),
      });
      patchCentral(archive, 'a.jpg', 8, 1, 2);
      patchCentral(archive, 'b.jpg', 10, 12, 2);
      const result = readGedzip(archive);
      expect(result.media.size).toBe(0);
      expect(result.warnings).toHaveLength(2);
    });

    it('rejects a truncated central directory', () => {
      const archive = zip({ 'gedcom.ged': GED });
      const view = new DataView(archive.buffer);
      // Point the end record at a central directory offset past the data.
      view.setUint32(archive.length - 22 + 16, archive.length - 30, true);
      expectError(() => readGedzip(archive), 'invalid');
    });
  });
});
