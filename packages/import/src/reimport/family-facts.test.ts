import { openMemoryTree, type TreeStore } from '@open-ancestry/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { importGedcom } from '../import';
import { FIXTURES, TODAY, fid, value } from '../test-helpers';
import { applyReimport, closeReimport, prepareReimport, type ReimportSession } from './index';

const SAMPLE = readFileSync(join(FIXTURES, 'ancestry-sample.ged'), 'utf8').replace(/^﻿/, '');
const renumber = (text: string, offset = 100) =>
  text.replace(/@([A-Z]+)(\d+)@/g, (_, p: string, n: string) => `@${p}${Number(n) + offset}@`);

let store: TreeStore;
beforeEach(async () => {
  store = openMemoryTree();
  await importGedcom({ bytes: SAMPLE }, store, { today: TODAY });
});
const defaults = (s: ReimportSession) =>
  new Set(s.diff.people.flatMap((p) => p.changes).filter((c) => c.defaultAccept).map((c) => c.id));
const marriages = (family: string) =>
  value<number>(
    store,
    "SELECT count(*) FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.family_id = ? AND e.type = 'MARR'",
    family,
  );
const marriageId = (family: string) =>
  value<string>(
    store,
    "SELECT e.id FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.family_id = ? AND e.type = 'MARR'",
    family,
  );

describe('family facts on re-import (#268)', () => {
  it('a marriage date the user corrected is not offered back as a second marriage', async () => {
    const f3 = fid(store, '@F3@');
    store.transact('Fix marriage', (tx) =>
      tx.update('event', marriageId(f3), { date_text: '12 MAY 1892' }),
    );
    // The export is unchanged: three-way, nothing should be offered (#185).
    const s = await prepareReimport(store, { bytes: renumber(SAMPLE) }, { today: TODAY });
    try {
      const offered = s.diff.people
        .flatMap((p) => p.changes)
        .filter((c) => c.kind === 'fact.add' && c.owner === 'family');
      expect(offered).toEqual([]);
      applyReimport(store, s, defaults(s), 'Re-import');
    } finally {
      closeReimport(s);
    }
    expect(marriages(f3)).toBe(1);
  });

  it("Ancestry's corrected marriage date replaces it rather than adding a second marriage", async () => {
    const f4 = fid(store, '@F4@');
    const updated = renumber(SAMPLE.replace('2 DATE 14 OCT 1895', '2 DATE 15 OCT 1895'));
    const s = await prepareReimport(store, { bytes: updated }, { today: TODAY });
    try {
      applyReimport(store, s, defaults(s), 'Re-import');
    } finally {
      closeReimport(s);
    }
    expect(marriages(f4)).toBe(1);
  });
});
