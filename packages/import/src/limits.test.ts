import { describe, expect, it } from 'vitest';
import { importGedcom } from './import';
import { ged, importInto } from './test-helpers';

/** `ged` for record lists too long to spread into arguments. */
const gedOf = (lines: string[]) =>
  ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '1 CHAR UTF-8', lines.join('\n'), '0 TRLR', ''].join('\n');
import { IMPORT_LIMITS, ImportError } from './index';

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
});
