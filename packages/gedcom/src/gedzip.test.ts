import { deflateSync, strToU8, zipSync, type Zippable } from 'fflate';
import { cpuMs } from './test-utils';
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

/**
 * Writes a zip by hand so one deflated payload can back thousands of entries
 * (zipSync would recompress each one). CRCs are left at 0; readGedzip ignores them.
 */
function handZip(entries: { name: string; data: Uint8Array; size: number }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data, size } of entries) {
    const n = strToU8(name);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const cd = new Uint8Array(46 + n.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    cd.set(n, 46);
    parts.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/**
 * A hand-built zip whose central directory lists `names` more than once over
 * the same local records: `aliases` maps an extra central name to the local
 * record (by name) it points at.
 */
function sharedZip(
  entries: { name: string; data: Uint8Array; size: number }[],
  aliases: Record<string, string>,
  { localNames = {} as Record<string, string>, shift = {} as Record<string, number> } = {},
): Uint8Array {
  const honest = handZip(entries);
  const view = new DataView(honest.buffer);
  const eocd = honest.length - 22;
  const cdStart = view.getUint32(eocd + 16, true);
  // Each local record's offset, by name.
  const offsets = new Map<string, number>();
  for (let p = 0; p < cdStart;) {
    const n = view.getUint16(p + 26, true);
    const name = new TextDecoder().decode(honest.subarray(p + 30, p + 30 + n));
    offsets.set(name, p);
    p += 30 + n + view.getUint32(p + 18, true);
  }
  const records = honest.slice(0, cdStart);
  // A different local name for an entry, same length (the central name stays).
  for (const [from, to] of Object.entries(localNames)) {
    records.set(strToU8(to), offsets.get(from)! + 30);
  }
  const central: Uint8Array[] = [];
  const add = (name: string, target: string) => {
    // The record it points at: the target's, or one nested in its data.
    const local = offsets.get(target)! + (shift[name] ?? 0);
    const n = strToU8(name);
    const cd = new Uint8Array(46 + n.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, view.getUint32(local + 18, true), true);
    cv.setUint32(24, view.getUint32(local + 22, true), true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, local, true);
    cd.set(n, 46);
    central.push(cd);
  };
  for (const { name } of entries) add(name, name);
  for (const [name, target] of Object.entries(aliases)) add(name, target);
  const cdSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, records.length, true);
  const out = new Uint8Array(records.length + cdSize + 22);
  let p = 0;
  for (const part of [records, ...central, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
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

  it('rejects 2,000 entries of 1 MiB zeros (2 GB from a 2 MB archive) before inflating', () => {
    const size = 1024 * 1024 - 1;
    const zeros = deflateSync(new Uint8Array(size));
    const entries = [{ name: 'gedcom.ged', data: deflateSync(GED), size: GED.length }];
    for (let i = 0; i < 2000; i++) entries.push({ name: `m/${i}.bin`, data: zeros, size });
    const archive = handZip(entries);
    expect(archive.length).toBeLessThan(3_000_000);
    // Over the default 256 MiB total, and over the aggregate ratio when the total is raised.
    // Inflating 2 GB would take many seconds of CPU; refusing up front takes almost none.
    const cpu = cpuMs(() => {
      expectError(() => readGedzip(archive), 'too-large');
      expectError(() => readGedzip(archive, { maxTotalSize: 4 * 1024 ** 3 }), 'ratio');
    });
    expect(cpu).toBeLessThan(1000);
  }, 30_000);

  it('reads a hand-built archive', () => {
    const archive = handZip([{ name: 'gedcom.ged', data: deflateSync(GED), size: GED.length }]);
    expect(readGedzip(archive).gedcom).toEqual(GED);
  });

  describe('entries sharing local records (#265)', () => {
    // 2 MiB that deflates about 170:1: under the ratio cap on its own.
    const sparse = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < sparse.length; i += 800) sparse[i] = (i * 2654435761) >>> 24;
    const deflated = deflateSync(sparse);
    const ged = { name: 'gedcom.ged', data: deflateSync(GED), size: GED.length };
    const photo = { name: 'a.bin', data: deflated, size: sparse.length };

    it('refuses central entries that point at one local record', () => {
      // Five names over one stream: each looks 170:1, and their summed sizes do too.
      const archive = sharedZip([ged, photo], {
        'b.bin': 'a.bin',
        'c.bin': 'a.bin',
        'd.bin': 'a.bin',
        'e.bin': 'a.bin',
      });
      expect(() => readGedzip(archive)).toThrow(/b\.bin shares its data with a\.bin/);
      expectError(() => readGedzip(archive), 'invalid');
    });

    it("refuses an entry whose record sits inside another entry's data", () => {
      // a.bin is stored, and its bytes are a whole local record for b.bin.
      const inner = handZip([{ name: 'b.bin', data: deflateSync(GED), size: GED.length }]);
      const record = inner.subarray(
        0,
        new DataView(inner.buffer).getUint32(inner.length - 6, true),
      );
      const archive = sharedZip(
        [ged, { name: 'a.bin', data: record, size: record.length }],
        { 'b.bin': 'a.bin' },
        { shift: { 'b.bin': 30 + 'a.bin'.length } },
      );
      patchCentral(archive, 'a.bin', 10, 0, 2);
      expect(() => readGedzip(archive)).toThrow(/b\.bin overlaps a\.bin/);
    });

    it("refuses an entry whose local name isn't its central name", () => {
      const archive = sharedZip([ged, photo], {}, { localNames: { 'a.bin': 'x.bin' } });
      expect(() => readGedzip(archive)).toThrow(/a\.bin is named x\.bin in its local header/);
    });

    it('compares the name bytes, so bit 11 set in only one header is no mismatch', () => {
      const archive = handZip([
        ged,
        { name: 'photos/Zoë.bin', data: deflateSync(GED), size: GED.length },
      ]);
      // Some writers flag UTF-8 in the central directory only.
      patchCentral(archive, 'photos/Zoë.bin', 8, 0x800, 2);
      expect([...readGedzip(archive).media.keys()]).toEqual(['photos/Zoë.bin']);
    });

    it('still reads an honest archive of distinct records', () => {
      const archive = handZip([ged, photo]);
      expect(readGedzip(archive).media.get('a.bin')).toEqual(sparse);
    });
  });

  it('reads UTF-8 names stored without bit 11, as Info-ZIP and macOS write them (#287)', () => {
    const archive = handZip([
      { name: 'gedcom.ged', data: deflateSync(GED), size: GED.length },
      { name: 'photos/Müller.jpg', data: deflateSync(GED), size: GED.length },
    ]);
    expect(readGedzip(archive).mediaPaths).toEqual(['photos/Müller.jpg']);
  });

  it('still reads a CP437 name that is not valid UTF-8', () => {
    const archive = handZip([{ name: 'gedcom.ged', data: deflateSync(GED), size: GED.length }]);
    const legacy = handZip([
      { name: 'gedcom.ged', data: deflateSync(GED), size: GED.length },
      { name: 'photos/M_ller.jpg', data: deflateSync(GED), size: GED.length },
    ]);
    // 0xFC is ü in Windows-1252 and not a UTF-8 sequence on its own.
    for (let p = 0; p < legacy.length; p++) if (legacy[p] === 0x5f) legacy[p] = 0xfc;
    expect(readGedzip(legacy).mediaPaths).toEqual(['photos/Müller.jpg']);
    expect(readGedzip(archive).mediaPaths).toEqual([]);
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

  it('treats composed and decomposed spellings of a name as duplicates', () => {
    const nfc = 'photos/Zoë.jpg'.normalize('NFC');
    const nfd = 'photos/Zoë.jpg'.normalize('NFD');
    const result = readGedzip(
      zip({ 'gedcom.ged': GED, [nfc]: new Uint8Array([1]), [nfd]: new Uint8Array([2]) }),
    );
    expect([...result.media.keys()]).toEqual([nfc]);
    expect(result.warnings[0]).toMatch(/Unicode form/);
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
      // 5 MB of zeros declared as 100 bytes passes the up-front checks. (Bigger only made
      // building the archive slow enough to time out on a busy machine.)
      const archive = zip({ 'gedcom.ged': GED, 'bomb.bin': new Uint8Array(5_000_000) });
      patchCentral(archive, 'bomb.bin', SIZE, 100);
      expect(cpuMs(() => expectError(() => readGedzip(archive), 'invalid'))).toBeLessThan(1000);
    }, 30_000);

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
