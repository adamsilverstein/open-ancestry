import { describe, expect, it } from 'vitest';
import { importGedcom } from './import';
import { coordinate } from './places';
import { ged, importInto, rows } from './test-helpers';

/** `ged` for record lists too long to spread into arguments. */
const gedOf = (lines: string[]) =>
  ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '1 CHAR UTF-8', lines.join('\n'), '0 TRLR', ''].join('\n');
import { IMPORT_LIMITS, ImportError } from './index';

/*
 * Hostile or just huge files (security review): caps that refuse a file
 * before it can exhaust memory, and no quadratic or catastrophic-backtracking
 * paths on input a real export can contain.
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
});

describe('no quadratic paths', () => {
  it('maps one person with 20k FAMS and MARR in seconds, matching every marriage', async () => {
    const n = 20_000;
    const lines = ['0 @I1@ INDI', '1 NAME Ada /Vale/'];
    for (let i = 0; i < n; i++) lines.push(`1 FAMS @F${i}@`);
    for (let i = 0; i < n; i++)
      lines.push('1 MARR', `2 DATE 1 JAN ${1000 + i}`, `2 PLAC Town ${i}`);
    for (let i = 0; i < n; i++) {
      lines.push(
        `0 @F${i}@ FAM`,
        '1 HUSB @I1@',
        '1 MARR',
        `2 DATE 1 JAN ${1000 + i}`,
        `2 PLAC Town ${i}`,
      );
    }
    const started = performance.now();
    const { store, report } = await importInto(gedOf(lines));
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(report.records.FAM).toBe(n);
    // Each person-level MARR matched its family's MARR: one event per family, none on the person.
    const [count] = rows<{ n: number }>(
      store,
      "SELECT count(*) AS n FROM event WHERE type = 'MARR'",
    );
    expect(count?.n).toBe(n);
  }, 60_000);

  it('warns once per repeated FAMS without scanning every link', async () => {
    const lines = ['0 @I1@ INDI'];
    for (let i = 0; i < 20_000; i++) lines.push(`1 FAMS @F${i}@`, `1 FAMS @F${i}@`);
    for (let i = 0; i < 20_000; i++) lines.push(`0 @F${i}@ FAM`, '1 HUSB @I1@');
    const started = performance.now();
    const { report } = await importInto(gedOf(lines), { maxWarnings: 10 });
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(report.warnings.filter((w) => w.code === 'duplicate-link')).toHaveLength(10);
  }, 60_000);

  it('parses coordinates without catastrophic backtracking', () => {
    const hostile = `N${' '.repeat(100_000)}1x`;
    const started = performance.now();
    expect(coordinate(hostile, 'lat')).toBeUndefined();
    // Surrounding whitespace is trimmed; only the value itself is capped.
    expect(coordinate(`${' '.repeat(100_000)}N51.5`, 'lat')).toBe(51.5);
    expect(performance.now() - started).toBeLessThan(50);
    expect(coordinate('  N 51.5 ', 'lat')).toBe(51.5);
    expect(coordinate('W0.25', 'long')).toBe(-0.25);
    expect(coordinate('-71.2', 'long')).toBe(-71.2);
  });
});
