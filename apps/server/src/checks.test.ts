import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
