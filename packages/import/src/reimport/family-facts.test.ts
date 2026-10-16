import { events, openMemoryTree, type TreeStore } from '@open-ancestry/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { importGedcom } from '../import';
import { FIXTURES, TODAY, fid, value } from '../test-helpers';
import { applyReimport, closeReimport, prepareReimport, type ReimportSession } from './index';

const SAMPLE = readFileSync(join(FIXTURES, 'ancestry-sample.ged'), 'utf8').replace(/^\uFEFF/, '');
const renumber = (text: string, offset = 100) =>
  text.replace(/@([A-Z]+)(\d+)@/g, (_, p: string, n: string) => `@${p}${Number(n) + offset}@`);

let store: TreeStore;
beforeEach(async () => {
  store = openMemoryTree();
  await importGedcom({ bytes: SAMPLE }, store, { today: TODAY });
});
const defaults = (s: ReimportSession) =>
  new Set(
    s.diff.people
      .flatMap((p) => p.changes)
      .filter((c) => c.defaultAccept)
      .map((c) => c.id),
  );
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

  it("offers a marriage's corrected date as a change that names the place", async () => {
    const updated = renumber(SAMPLE.replace('2 DATE 14 OCT 1895', '2 DATE 15 OCT 1895'));
    const s = await prepareReimport(store, { bytes: updated }, { today: TODAY });
    try {
      const changes = s.diff.people.flatMap((p) => p.changes);
      expect(changes.filter((c) => c.kind === 'fact.add')).toEqual([]);
      expect(changes.filter((c) => c.kind === 'fact.change')).toMatchObject([
        {
          before: { type: 'MARR', date: '14 OCT 1895', place: 'Elderford, Cask County, Ohio, USA' },
          after: { type: 'MARR', date: '15 OCT 1895', place: 'Elderford, Cask County, Ohio, USA' },
          defaultAccept: true,
        },
      ]);
    } finally {
      closeReimport(s);
    }
  });

  it('pairs a marriage whose date and place were both corrected, as Ancestry often does', async () => {
    const f3 = fid(store, '@F3@');
    // The sample gives Josiah's marriage on his own record too; an export corrects both.
    const before = '2 DATE 1892\n2 PLAC Elderford, Cask County, Ohio, USA';
    expect(SAMPLE.split(before)).toHaveLength(3);
    const updated = renumber(
      SAMPLE.replaceAll(before, '2 DATE 12 JUN 1892\n2 PLAC Wexmoor, Dale County, Ohio, USA'),
    );
    const s = await prepareReimport(store, { bytes: updated }, { today: TODAY });
    try {
      const changes = s.diff.people.flatMap((p) => p.changes);
      expect(changes.filter((c) => c.kind === 'fact.add')).toEqual([]);
      expect(changes.filter((c) => c.kind === 'fact.change')).toMatchObject([
        {
          before: { type: 'MARR', date: '1892', place: 'Elderford, Cask County, Ohio, USA' },
          after: { type: 'MARR', date: '12 JUN 1892', place: 'Wexmoor, Dale County, Ohio, USA' },
          defaultAccept: true,
        },
      ]);
      applyReimport(store, s, defaults(s), 'Re-import');
    } finally {
      closeReimport(s);
    }
    expect(marriages(f3)).toBe(1);
  });

  it('pairs a lone marriage only with one that came from an import, not one the user added', async () => {
    const f3 = fid(store, '@F3@');
    // The user's own second family fact of the type: no longer one of a kind on each side.
    store.transact('Add engagement', (tx) =>
      events.create(tx, { type: 'ENGA', date_text: '1891', roles: [{ family_id: f3 }] }),
    );
    const updated = renumber(
      SAMPLE.replace(
        '2 DATE 1892\n2 PLAC Elderford, Cask County, Ohio, USA\n2 SOUR @S4@',
        '2 DATE 1892\n2 PLAC Elderford, Cask County, Ohio, USA\n2 SOUR @S4@\n1 ENGA\n2 DATE 1890\n2 PLAC Dalesend, Wexmoor',
      ),
    );
    const s = await prepareReimport(store, { bytes: updated }, { today: TODAY });
    try {
      const changes = s.diff.people.flatMap((p) => p.changes);
      // The export's engagement is new, not a correction of the one the user typed in.
      expect(changes.filter((c) => c.kind === 'fact.change')).toEqual([]);
      expect(changes.filter((c) => c.kind === 'fact.add').map((c) => c.kind)).toEqual(['fact.add']);
    } finally {
      closeReimport(s);
    }
  });
});
