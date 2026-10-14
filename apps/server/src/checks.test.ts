import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMemoryTree, openTree } from '@open-ancestry/db';
import { importGedcom } from '@open-ancestry/import';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTree } from './checks';
import { createTestTree, testApi, type TestApi } from './test/helpers';

/* GET /api/trees/:tree/checks and dismissing issues (Tree checker, #57). */

let api: TestApi;
let base: string;
beforeEach(async () => {
  api = await testApi();
  base = await createTestTree(api);
});
afterEach(() => api.close());

interface Issue {
  key: string;
  kind: string;
  category: string;
  message: string;
  people: { id: string; given: string | null }[];
}
interface Checks {
  counts: Record<string, number>;
  items: Issue[];
  dismissed: Issue[];
}

const checks = async (): Promise<Checks> => (await api.get(`${base}/checks`)).json();

type Ev = [type: string, date: string];
async function person(given: string, surname: string, sex: string, events: Ev[] = []) {
  const res = await api.post(`${base}/people`, {
    sex,
    names: [{ given, surname }],
    events: events.map(([type, date_text]) => ({ type, date_text })),
  });
  return res.json().person.id as string;
}
const addParent = (child: string, parent: string) =>
  api.post(`${base}/people/${child}/parents`, { personId: parent });

describe('tree checker', () => {
  it('finds impossible dates', async () => {
    const backwards = await person('Bram', 'Vale', 'M', [
      ['BIRT', '1900'],
      ['DEAT', '1890'],
    ]);
    const parent = await person('Cora', 'Vale', 'F', [['BIRT', '1950']]);
    const child = await person('Dell', 'Vale', 'F', [['BIRT', '1940']]);
    await addParent(child, parent);
    const young = await person('Ezra', 'Reed', 'M', [['BIRT', '1900']]);
    const kid = await person('Finn', 'Reed', 'M', [['BIRT', '1908']]);
    await addParent(kid, young);
    const old = await person('Gus', 'Hale', 'M', [['BIRT', '1800']]);
    const late = await person('Hal', 'Hale', 'M', [['BIRT', '1880']]);
    await addParent(late, old);
    const ghost = await person('Ida', 'Lark', 'F', [
      ['BIRT', '1850'],
      ['DEAT', '1900'],
      ['RESI', '1910'],
      ['BURI', '1901'],
    ]);

    const { items } = await checks();
    const kinds = (id: string) =>
      items
        .filter((i) => i.people.some((p) => p.id === id))
        .map((i) => i.kind)
        .sort();
    expect(kinds(backwards)).toContain('death-before-birth');
    expect(kinds(child)).toContain('child-born-before-parent');
    expect(kinds(kid)).toContain('parent-too-young');
    expect(kinds(late)).toContain('parent-too-old');
    expect(kinds(ghost)).toEqual(['event-after-death', 'no-sources']);
    const ghostIssue = items.find((i) => i.kind === 'event-after-death')!;
    expect(ghostIssue.message).toBe('Residence in 1910, after death in 1900');
    expect(items.find((i) => i.kind === 'parent-too-young')!.message).toBe(
      'Ezra Reed was 8 at the birth of Finn Reed',
    );
  });

  it('gives approximate dates the benefit of the doubt', async () => {
    const id = await person('Jo', 'Vale', 'M', [
      ['BIRT', 'ABT 1900'],
      ['DEAT', '1899'],
    ]);
    const parent = await person('Kit', 'Vale', 'M', [['BIRT', 'BEF 1920']]);
    const child = await person('Lu', 'Vale', 'F', [['BIRT', '1910']]);
    await addParent(child, parent);
    const kinds = (await checks()).items.filter((i) => i.category === 'dates').map((i) => i.kind);
    expect(kinds).toEqual([]);
    expect(id).toBeTruthy();
  });

  it('finds possible duplicates by sound-alike name and close dates', async () => {
    const a = await person('Rowan', 'Ashdown', 'M', [['BIRT', '12 MAR 1880']]);
    const b = await person('Rowan', 'Ashdowne', 'M', [['BIRT', 'ABT 1881']]);
    await person('Rowan', 'Ashdown', 'M', [['BIRT', '1930']]); // different generation
    await person('Rhona', 'Ashdown', 'F', [['BIRT', '1880']]); // different person
    const { items } = await checks();
    const dupes = items.filter((i) => i.kind === 'possible-duplicate');
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.people.map((p) => p.id).sort()).toEqual([a, b].sort());
    expect(dupes[0]!.key).toBe(`possible-duplicate:${[a, b].sort().join('+')}`);
  });

  it('counts only dates within a few years as agreeing evidence for a duplicate', async () => {
    const pairs: [birthA: string, birthB: string, duplicate: boolean][] = [
      ['19 DEC 1843', 'BEF 1965', false],
      ['AFT 1814', 'ABT 1945', false],
      ['AFT 1814', 'AFT 1820', false],
      ['BET 1840 AND 1845', '1843', true],
      ['BET 1800 AND 1900', '1850', false],
      ['1 JAN 1750/51', '1751', true],
      ['', '', false],
    ];
    const ids: [string, string, boolean][] = [];
    for (const [i, [a, b, duplicate]] of pairs.entries()) {
      const given = `Linnea${'x'.repeat(i)}`;
      const events = (date: string): Ev[] => (date ? [['BIRT', date]] : []);
      ids.push([
        await person(given, 'Jessamy', 'F', events(a)),
        await person(given, 'Jessamy', 'F', events(b)),
        duplicate,
      ]);
    }
    const dupes = new Set(
      (await checks()).items
        .filter((i) => i.kind === 'possible-duplicate')
        .map((i) => i.people.map((p) => p.id).join('+')),
    );
    for (const [i, [a, b, duplicate]] of ids.entries()) {
      expect(dupes.has([a, b].sort().join('+')), JSON.stringify(pairs[i])).toBe(duplicate);
    }
  });

  it('still lets an open-ended date rule a pair out, and agreeing deaths rule it in', async () => {
    await person('Ansel', 'Brook', 'M', [
      ['BIRT', 'BEF 1800'],
      ['DEAT', '1870'],
    ]);
    await person('Ansel', 'Brook', 'M', [
      ['BIRT', '1850'],
      ['DEAT', '1870'],
    ]);
    const a = await person('Bryn', 'Brook', 'M', [
      ['BIRT', 'AFT 1800'],
      ['DEAT', '12 MAY 1870'],
    ]);
    const b = await person('Bryn', 'Brook', 'M', [
      ['BIRT', '1850'],
      ['DEAT', '1870'],
    ]);
    const dupes = (await checks()).items.filter((i) => i.kind === 'possible-duplicate');
    expect(dupes.map((d) => d.people.map((p) => p.id).sort())).toEqual([[a, b].sort()]);
  });

  it('compares every name, so a maiden and a married name can match', async () => {
    const maiden = await person('Mary', 'Stone', 'F', [['BIRT', '1850']]);
    await api.post(`${base}/people/${maiden}/names`, {
      given: 'Mary',
      surname: 'Wren',
      type: 'married',
    });
    const married = await person('Mary', 'Wren', 'F', [['BIRT', 'ABT 1851']]);
    const dupes = (await checks()).items.filter((i) => i.kind === 'possible-duplicate');
    expect(dupes.map((d) => d.people.map((p) => p.id).sort())).toEqual([[maiden, married].sort()]);
  });

  it('compares exact dates within a year', async () => {
    const id = await person('Oda', 'Vale', 'F', [
      ['BIRT', 'JUN 1900'],
      ['DEAT', 'MAR 1900'],
      ['RESI', '1 APR 1900'],
    ]);
    const kinds = (await checks()).items
      .filter((i) => i.people.some((p) => p.id === id))
      .map((i) => i.kind)
      .sort();
    expect(kinds).toEqual(['death-before-birth', 'event-after-death', 'no-sources']);
  });

  it('counts citations on a name or a family as sources', async () => {
    const named = await person('Pia', 'Vale', 'F');
    const partnered = await person('Quin', 'Vale', 'M');
    const store = openTree(join(api.root, 'Test.oatree'));
    try {
      store.transact('test rows', (tx) => {
        const source = tx.insert('source', { title: 'Register' });
        const cite = (owner_type: 'person_name' | 'family', owner_id: string) =>
          tx.insert('citation_link', {
            citation_id: tx.insert('citation', { source_id: source.id }).id,
            owner_type,
            owner_id,
          });
        const name = tx.store.stmt('SELECT id FROM person_name WHERE person_id = ?').get(named) as {
          id: string;
        };
        cite('person_name', name.id);
        const family = tx.insert('family', { partner2_id: partnered });
        cite('family', family.id);
      });
    } finally {
      store.close();
    }
    const unsourced = (await checks()).items.filter((i) => i.kind === 'no-sources');
    expect(unsourced.flatMap((i) => i.people.map((p) => p.id))).not.toContain(named);
    expect(unsourced.flatMap((i) => i.people.map((p) => p.id))).not.toContain(partnered);
  });

  it('keeps the report current across edits, dismissals and other connections', async () => {
    const id = await person('Rue', 'Vale', 'F', [['BIRT', '1900']]);
    expect((await checks()).counts.sources).toBe(1);
    await person('Sol', 'Vale', 'M');
    expect((await checks()).counts.sources).toBe(2);
    const [issue] = (await checks()).items;
    await api.post(`${base}/checks/dismiss`, { keys: [issue!.key] });
    expect((await checks()).counts).toMatchObject({ sources: 1, dismissed: 1 });
    await api.post(`${base}/undo`);
    expect((await checks()).counts).toMatchObject({ sources: 2, dismissed: 0 });
    // A write through another connection (an import worker) is seen too.
    const store = openTree(join(api.root, 'Test.oatree'));
    try {
      store.transact('test rows', (tx) => {
        tx.insert('event_role', {
          event_id: tx.insert('event', { type: 'DEAT', date_sort: 18000101 }).id,
          person_id: id,
        });
      });
    } finally {
      store.close();
    }
    expect((await checks()).counts.dates).toBe(1);
  });

  it('lists people without sources and counts by category', async () => {
    await person('Mo', 'Vale', 'M', [['BIRT', '1900']]);
    const { counts } = await checks();
    expect(counts).toMatchObject({ duplicates: 0, dates: 0, sources: 1, dismissed: 0 });
  });

  it('dismisses and restores issues as undoable edits', async () => {
    await person('Ned', 'Vale', 'M', [['BIRT', '1900']]);
    const [issue] = (await checks()).items;
    const res = await api.post(`${base}/checks/dismiss`, { keys: [issue!.key] });
    expect(res.statusCode).toBe(200);
    let after = await checks();
    expect(after.items).toHaveLength(0);
    expect(after.dismissed.map((i) => i.key)).toEqual([issue!.key]);
    expect(after.counts.dismissed).toBe(1);
    const history = (await api.get(`${base}/history?limit=1`)).json();
    expect(history.items[0].label).toBe('Dismiss check: No sources for Ned Vale');

    await api.post(`${base}/undo`);
    expect((await checks()).items.map((i) => i.key)).toEqual([issue!.key]);
    await api.post(`${base}/redo`);
    await api.post(`${base}/checks/restore`, { keys: [issue!.key] });
    after = await checks();
    expect(after.items.map((i) => i.key)).toEqual([issue!.key]);
    expect(after.dismissed).toEqual([]);
  });

  it('validates dismiss bodies', async () => {
    for (const body of [{}, { keys: [] }, { keys: ['x'.repeat(400)] }, { keys: ['bad key!'] }]) {
      const res = await api.post(`${base}/checks/dismiss`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('dismissals in the JSON interchange', () => {
  it('round-trip through export and import', async () => {
    await person('Ned', 'Vale', 'M', [['BIRT', '1900']]);
    const [issue] = (await checks()).items;
    await api.post(`${base}/checks/dismiss`, { keys: [issue!.key] });

    const exported = await api.get(`${base}/export.json`);
    const doc = JSON.parse(exported.body) as { tables: { meta: { key: string }[] } };
    expect(doc.tables.meta.map((m) => m.key)).toContain(`check.dismissed:${issue!.key}`);

    const { openMemoryTree, importJson } = await import('@open-ancestry/db');
    const copy = openMemoryTree();
    importJson(copy, doc);
    const { checkTree } = await import('./checks');
    const report = checkTree(copy);
    expect(report.items).toEqual([]);
    expect(report.dismissed.map((i) => i.key)).toEqual([issue!.key]);
  });
});

describe('the generated fixture', () => {
  it('pins the number of issues in synthetic-1000.ged', async () => {
    const store = openMemoryTree();
    const file = join(import.meta.dirname, '../../../fixtures/generated/synthetic-1000.ged');
    await importGedcom({ bytes: readFileSync(file) }, store);
    const { counts } = checkTree(store);
    // Before open-ended dates stopped counting as agreement, 88 pairs were reported
    // (69 with BEF or AFT); each of these 27 has births or deaths within a few years.
    expect(counts).toEqual({ duplicates: 27, dates: 4, sources: 182, dismissed: 0 });
  });
});
