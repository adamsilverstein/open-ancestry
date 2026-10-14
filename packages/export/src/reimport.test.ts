import { openMemoryTree } from '@open-ancestry/db';
import { applyReimport, closeReimport, importGedcom, prepareReimport } from '@open-ancestry/import';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportGedcom } from './gedcom';

const SAMPLE = readFileSync(
  join(import.meta.dirname, '../../../fixtures/ancestry-sample.ged'),
  'utf8',
).replace(/^\uFEFF/, '');
const NOW = new Date('2026-10-14T12:00:00Z');
const renumber = (text: string) =>
  text.replace(/@([A-Z]+)(\d+)@/g, (_, p: string, n: string) => `@${p}${Number(n) + 100}@`);
const count = (text: string, re: RegExp) => text.split('\n').filter((l) => re.test(l)).length;

async function reimportNothing(text: string) {
  const store = openMemoryTree();
  await importGedcom({ bytes: SAMPLE }, store, { today: NOW });
  const before = exportGedcom(store, { version: '5.5.1', now: NOW });
  const session = await prepareReimport(store, { bytes: text }, { today: NOW });
  applyReimport(store, session, new Set(), 'Re-import');
  closeReimport(session);
  return { before, after: exportGedcom(store, { version: '5.5.1', now: NOW }), store };
}

describe('export after a re-import (#72 review)', () => {
  it('a no-op re-import of the same export changes nothing in the export', async () => {
    const { before, after } = await reimportNothing(SAMPLE);
    expect(after).toBe(before);
  });

  it('a renumbered no-op re-import writes each record once, verbatim', async () => {
    const { after } = await reimportNothing(renumber(SAMPLE));
    expect(count(after, /^0 @S\d+@ SOUR/)).toBe(5);
    expect(count(after, /^0 @R\d+@ REPO/)).toBe(1);
    expect(count(after, /^0 @O\d+@ OBJE/)).toBe(2);
    expect(count(after, /^0 @I\d+@ INDI/)).toBe(26);
    expect(count(after, /^0 @SUBM\d+@ SUBM/)).toBe(1);
    // Untouched people are copied verbatim from the new export.
    const thaddeus = renumber(SAMPLE)
      .split('\n0 ')
      .find((r) => r.startsWith('@I101@ INDI'))!;
    expect(after).toContain(`0 ${thaddeus}`);
  });

  it('regenerates a person whose incoming change was rejected', async () => {
    const changed = renumber(SAMPLE.replace('2 DATE Abt. 1842', '2 DATE 12 MAR 1842'));
    const { after } = await reimportNothing(changed);
    expect(after).not.toContain('12 MAR 1842');
    expect(after).toContain('Abt. 1842');
  });
});
