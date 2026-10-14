import { describe, expect, it } from 'vitest';
import { coordinate } from './places';
import { importInto, rows } from './test-helpers';

/*
 * Real exports (and hostile files) can put thousands of families and
 * marriages on one person; nothing here may be quadratic, and coordinate
 * parsing must not backtrack (issues #81, #83).
 */

/** A GEDCOM 5.5.1 file around record lines too many to spread into arguments. */
const gedOf = (lines: string[]) =>
  ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '1 CHAR UTF-8', lines.join('\n'), '0 TRLR', ''].join('\n');

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
