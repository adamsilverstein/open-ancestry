import { openMemoryTree, type TreeStore } from '@open-ancestry/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importGedcom } from '../import';
import { FIXTURES, TODAY, pid, value } from '../test-helpers';
import { applyReimport, closeReimport, prepareReimport, type ReimportSession } from './index';

/*
 * #302: a person's non-singular fact (a residence) whose date and place an
 * export corrects together pairs with the tree's only when both cite the same
 * record: the same Ancestry record id, or the same source and page. Otherwise
 * it stays a new fact plus a "not in the new export" line.
 */

const SAMPLE = readFileSync(join(FIXTURES, 'ancestry-sample.ged'), 'utf8').replace(/^\uFEFF/, '');
const renumber = (text: string) =>
  text.replace(/@([A-Z]+)(\d+)@/g, (_, p: string, n: string) => `@${p}${Number(n) + 100}@`);

/** Josiah's 1900 census residence, as the sample has it. */
const RESI = [
  '1 RESI',
  '2 DATE 1900',
  '2 PLAC Elderford, Cask County, Ohio, USA',
  '2 NOTE Marital Status: Married; Relation to Head of House: Head',
  '2 SOUR @S1@',
  '3 PAGE Year: 1900; Census Place: Elderford, Cask, Ohio; Roll: T623_1234; Page: 5B',
  '3 _APID 1,7602::50000123',
].join('\n');
const corrected = (resi: string) =>
  resi
    .replace('2 DATE 1900', '2 DATE 4 JUN 1900')
    .replace('2 PLAC Elderford, Cask County, Ohio, USA', '2 PLAC Wexmoor, Dale County, Ohio, USA');

async function tree(text = SAMPLE): Promise<TreeStore> {
  expect(text).toContain('1 RESI\n2 DATE 1900');
  const store = openMemoryTree();
  await importGedcom({ bytes: text }, store, { today: TODAY });
  return store;
}
const josiahs = (store: TreeStore, s: ReimportSession) =>
  s.diff.people.filter((p) => p.existingId === pid(store, '@I3@')).flatMap((p) => p.changes);
const residenceKinds = (store: TreeStore, s: ReimportSession) =>
  josiahs(store, s)
    .filter((c) => 'fact' in c || 'after' in c)
    .filter(
      (c) => (c.kind === 'fact.change' ? c.after.type : 'fact' in c ? c.fact.type : '') === 'RESI',
    )
    .map((c) => c.kind)
    .sort();
const defaults = (s: ReimportSession) =>
  new Set(
    s.diff.people
      .flatMap((p) => p.changes)
      .filter((c) => c.defaultAccept)
      .map((c) => c.id),
  );
const residences = (store: TreeStore) =>
  value<number>(
    store,
    "SELECT count(*) FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.person_id = ? AND e.type = 'RESI'",
    pid(store, '@I3@'),
  );

describe("a person's corrected fact on re-import (#302)", () => {
  it('pairs a residence whose date and place change when both cite the same record', async () => {
    expect(SAMPLE).toContain(RESI);
    const store = await tree();
    const before = residences(store);
    const s = await prepareReimport(
      store,
      { bytes: renumber(SAMPLE.replace(RESI, corrected(RESI))) },
      { today: TODAY },
    );
    try {
      expect(residenceKinds(store, s)).toEqual(['fact.change']);
      expect(josiahs(store, s).find((c) => c.kind === 'fact.change')).toMatchObject({
        before: { type: 'RESI', date: '1900', place: 'Elderford, Cask County, Ohio, USA' },
        after: { type: 'RESI', date: '4 JUN 1900', place: 'Wexmoor, Dale County, Ohio, USA' },
        defaultAccept: true,
      });
      applyReimport(store, s, defaults(s), 'Re-import');
    } finally {
      closeReimport(s);
    }
    expect(residences(store)).toBe(before);
  });

  it('keeps an add and a missing line when the new residence cites another record', async () => {
    const store = await tree();
    const other = corrected(RESI)
      .replace(
        '3 PAGE Year: 1900; Census Place: Elderford, Cask, Ohio; Roll: T623_1234; Page: 5B',
        '3 PAGE Year: 1910; Census Place: Wexmoor, Dale, Ohio; Page: 2A',
      )
      .replace('3 _APID 1,7602::50000123', '3 _APID 1,7884::60000456');
    const s = await prepareReimport(
      store,
      { bytes: renumber(SAMPLE.replace(RESI, other)) },
      {
        today: TODAY,
      },
    );
    try {
      expect(residenceKinds(store, s)).toEqual(['fact.add', 'fact.missing']);
    } finally {
      closeReimport(s);
    }
  });

  it('does not pair on a source cited without a page or record id', async () => {
    // A whole-tree source with no page says nothing about which record this is.
    const bare = RESI.split('\n')
      .filter((l) => !l.startsWith('3 '))
      .join('\n');
    const store = await tree(SAMPLE.replace(RESI, bare));
    const s = await prepareReimport(
      store,
      { bytes: renumber(SAMPLE.replace(RESI, corrected(bare))) },
      {
        today: TODAY,
      },
    );
    try {
      expect(residenceKinds(store, s)).toEqual(['fact.add', 'fact.missing']);
    } finally {
      closeReimport(s);
    }
  });
});
