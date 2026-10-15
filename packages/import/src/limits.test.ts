import { randomBytes } from 'node:crypto';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTree, treePaths } from '@open-ancestry/db';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importGedcom } from './import';
import { ged, importInto, TODAY } from './test-helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

/** `ged` for record lists too long to spread into arguments. */
const gedOf = (lines: string[]) =>
  ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '1 CHAR UTF-8', lines.join('\n'), '0 TRLR', ''].join('\n');
import { IMPORT_LIMITS, ImportError, resolveImportLimits } from './index';

/*
 * Hostile or just huge files (issue #84): caps that refuse a file before it
 * can exhaust memory.
 */

const refused = async (text: string) => {
  const error = await importInto(text).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ImportError);
  expect((error as ImportError).code).toBe('too-large');
  return (error as ImportError).message;
};

describe('import limits', () => {
  it('refuses files over the byte limit (64 MiB by default)', async () => {
    expect(IMPORT_LIMITS.maxBytes).toBe(64 * 1024 * 1024);
    const error = await importGedcom(
      { bytes: ged('0 @I1@ INDI') },
      { dir: '/nonexistent/x.oatree' },
      {
        maxBytes: 10,
      },
    ).catch((e: unknown) => e);
    expect((error as ImportError).code).toBe('too-large');
  });

  it('refuses a line longer than the line limit', async () => {
    const long = 'x'.repeat(IMPORT_LIMITS.maxLineLength + 1);
    expect(await refused(ged('0 @I1@ INDI', `1 NOTE ${long}`))).toMatch(/line \d+ is longer/i);
    // At the limit is fine.
    const ok = 'x'.repeat(IMPORT_LIMITS.maxLineLength - '1 NOTE '.length);
    await expect(importInto(ged('0 @I1@ INDI', `1 NOTE ${ok}`))).resolves.toBeTruthy();
  });

  it('refuses a record with too many CONT/CONC lines', async () => {
    const conts = Array.from({ length: IMPORT_LIMITS.maxContinuations + 1 }, () => '2 CONT a');
    expect(await refused(gedOf(['0 @I1@ INDI', '1 NOTE start', ...conts]))).toMatch(
      /continuation lines/i,
    );
  });

  it('refuses a file with too many records', async () => {
    const records = Array.from(
      { length: IMPORT_LIMITS.maxRecords + 1 },
      (_, i) => `0 @N${i}@ NOTE x`,
    );
    expect(await refused(gedOf(records))).toMatch(/records/i);
  });

  it('applies the line, record and CONT caps to UTF-16 files after decoding', async () => {
    const conts = Array.from({ length: IMPORT_LIMITS.maxContinuations + 1 }, () => '2 CONT a');
    const text = gedOf(['0 @I1@ INDI', '1 NOTE start', ...conts]).replace('UTF-8', 'UNICODE');
    for (const encoding of ['utf16le', 'utf16be'] as const) {
      const le = Buffer.from(`\ufeff${text}`, 'utf16le');
      const bytes = encoding === 'utf16le' ? le : Buffer.from(le).swap16();
      expect(await refused(bytes as unknown as string)).toMatch(/continuation lines/i);
    }
    // Without a byte-order mark, sniffed from the leading `0`.
    expect(await refused(Buffer.from(text, 'utf16le') as unknown as string)).toMatch(
      /continuation lines/i,
    );
  });

  it('takes limits per import, filling the rest from the defaults', async () => {
    expect(resolveImportLimits({ maxContinuations: 3 })).toEqual({
      ...IMPORT_LIMITS,
      maxContinuations: 3,
    });
    const text = ged('0 @I1@ INDI', '1 NOTE a', '2 CONT b', '2 CONT c', '2 CONT d', '2 CONT e');
    const error = await importInto(text, { limits: { maxContinuations: 3 } }).catch(
      (e: unknown) => e,
    );
    expect((error as ImportError).code).toBe('too-large');
    await expect(importInto(text, { limits: { maxContinuations: 4 } })).resolves.toBeTruthy();
  });
});

describe('GEDZIP limits', () => {
  const tmp = makeTempDir('oa-limits-');
  const photo = randomBytes(64 * 1024); // incompressible
  const small = ged('0 @I1@ INDI', '1 NAME Ada /Vale/', '1 OBJE', '2 FILE photos/a.jpg');

  it('caps the GEDCOM text, not the whole archive, so exports with photos fit', async () => {
    const zip = zipSync({ 'gedcom.ged': Buffer.from(small), 'photos/a.jpg': photo });
    // The archive is far over maxBytes; its GEDCOM is not.
    const limits = { maxBytes: 4096 };
    expect(zip.length).toBeGreaterThan(limits.maxBytes);
    const dir = join(tmp, 'photos.oatree');
    const report = await importGedcom({ gedzip: zip }, { dir }, { today: TODAY, limits });
    expect(report.media.linked).toBe(1);
    // From a path too, sized by its contents rather than refused up front.
    const path = join(tmp, 'export.gdz');
    writeFileSync(path, zip);
    const fromPath = await importGedcom(
      { path },
      { dir: join(tmp, 'path.oatree') },
      { today: TODAY, limits },
    );
    expect(fromPath.media.linked).toBe(1);
  });

  it('refuses a GEDCOM inside the archive over maxBytes', async () => {
    const big = ged('0 @I1@ INDI', `1 NOTE ${'x'.repeat(8000)}`);
    const zip = zipSync({ 'gedcom.ged': Buffer.from(big) });
    const error = await importGedcom(
      { gedzip: zip },
      { dir: join(tmp, 'big.oatree') },
      { limits: { maxBytes: 4096 } },
    ).catch((e: unknown) => e);
    expect((error as ImportError).code).toBe('too-large');
  });

  it('refuses an archive over maxArchiveBytes and media over the media caps', async () => {
    const zip = zipSync({ 'gedcom.ged': Buffer.from(small), 'photos/a.jpg': photo });
    const refusedWith = async (limits: Record<string, number>) => {
      const error = await importGedcom(
        { gedzip: zip },
        { dir: join(tmp, `x${Math.random()}.oatree`) },
        { limits },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ImportError);
      return (error as ImportError).code;
    };
    expect(await refusedWith({ maxArchiveBytes: 32 * 1024 })).toBe('too-large');
    expect(await refusedWith({ maxMediaTotalBytes: 32 * 1024 })).toBe('too-large');
    expect(await refusedWith({ maxMediaBytes: 32 * 1024 })).toBe('too-large');
  });
});

describe('after an import commits', () => {
  it('truncates the write-ahead log, which can be as large as the database', async () => {
    const root = makeTempDir('oa-wal-');
    const dir = join(root, 'wal.oatree');
    const store = createTree(dir);
    try {
      const people = Array.from({ length: 2000 }, (_, i) => [
        `0 @I${i}@ INDI`,
        `1 NAME Person${i} /Vale/`,
        `1 NOTE ${'n'.repeat(200)}`,
      ]).flat();
      await importGedcom({ bytes: ged(...people) }, store, { today: TODAY });
      const wal = `${treePaths(dir).database}-wal`;
      // Still open (as the server's connection is), yet the log is empty.
      expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
