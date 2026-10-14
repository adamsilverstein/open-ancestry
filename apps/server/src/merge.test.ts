import { join } from 'node:path';
import { openMemoryTree, openTree, ulid, type TreeStore } from '@open-ancestry/db';
import { parseGedcom } from '@open-ancestry/gedcom';
import { importGedcom } from '@open-ancestry/import';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestTree, testApi, type TestApi } from './test/helpers';

/* POST /api/trees/:tree/people/:id/merge (#57): one undoable merge. */

let api: TestApi;
let base: string;
beforeEach(async () => {
  api = await testApi();
  base = await createTestTree(api, 'Merge');
});
afterEach(() => api.close());

type Ev = [type: string, date: string, place?: string];
async function person(given: string, surname: string, sex: string, events: Ev[] = []) {
  const res = await api.post(`${base}/people`, {
    sex,
    names: [{ given, surname }],
    events: events.map(([type, date_text, place]) => ({ type, date_text, place })),
  });
  return res.json().person.id as string;
}

interface Detail {
  person: { id: string; sex: string; privacy: string; primary_media_id: string | null };
  names: { given: string | null; surname: string | null; is_primary: number; type: string }[];
  events: { event: { type: string; date_text: string | null }; role: { is_preferred: number } }[];
  citations: { citation: { page: string | null } }[];
  parentFamilies: { partner1: { id: string } | null; siblings: unknown[] }[];
  partnerFamilies: { partner: { id: string } | null; children: { person: { id: string } }[] }[];
  tags: { name: string }[];
  notes: { text: string }[];
  media: { media: { id: string } }[];
}
const detail = async (id: string) =>
  (await api.get(`${base}/people/${id}`)).json() as Promise<Detail>;
const status = async (id: string) => (await api.get(`${base}/people/${id}`)).statusCode;

/** Runs `fn` against the test tree's database directly, for rows the API has no routes for. */
function withStore<T>(fn: (store: TreeStore) => T): T {
  const store = openTree(join(api.root, 'Merge.oatree'));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** Adds rows the API has no routes for yet: a citation and a media link on a person. */
function addSourceAndPhoto(personId: string, page: string) {
  const store = openTree(join(api.root, 'Merge.oatree'));
  try {
    store.transact('test rows', (tx) => {
      const source = tx.insert('source', { title: 'Parish register' });
      const citation = tx.insert('citation', { source_id: source.id, page });
      tx.insert('citation_link', {
        citation_id: citation.id,
        owner_type: 'person',
        owner_id: personId,
      });
      const media = tx.insert('media', { kind: 'photo', title: `Photo ${page}` });
      tx.insert('media_link', { media_id: media.id, owner_type: 'person', owner_id: personId });
      tx.update('person', personId, { primary_media_id: media.id });
    });
  } finally {
    store.close();
  }
}

describe('merge people', () => {
  it('moves facts, names, relationships, sources, media, tags and notes, then undoes', async () => {
    const keep = await person('Rowan', 'Ashdown', 'M', [
      ['BIRT', '12 MAR 1880', 'Brackenford'],
      ['RESI', '1900', 'Wexmoor'],
    ]);
    const other = await person('Rowan', 'Ashdowne', 'U', [
      ['BIRT', 'ABT 1881', 'Wexmoor'],
      ['DEAT', '3 NOV 1950', 'Thornbury'],
      ['RESI', '1900', 'Wexmoor'],
    ]);
    const father = (
      await api.post(`${base}/people/${keep}/parents`, {
        person: { names: [{ given: 'Edmund', surname: 'Ashdown' }] },
      })
    ).json().parentId as string;
    // The duplicate was recorded with the same father in its own family.
    await api.post(`${base}/people/${other}/parents`, { personId: father });
    const spouse = (
      await api.post(`${base}/people/${other}/spouses`, {
        person: { names: [{ given: 'Iris', surname: 'Vale' }] },
      })
    ).json().spouseId as string;
    const tag = (await api.post(`${base}/tags`, { name: 'Smiths' })).json().tag.id;
    await api.post(`${base}/people/${other}/tags`, { tagId: tag });
    await api.post(`${base}/notes`, {
      text: 'From the second record',
      owner_type: 'person',
      owner_id: other,
    });
    addSourceAndPhoto(other, 'entry 41');

    const res = await api.post(`${base}/people/${keep}/merge`, {
      otherId: other,
      choices: { sex: 'keep', preferred: { BIRT: 'other' } },
    });
    expect(res.statusCode).toBe(200);
    expect(await status(other)).toBe(404);

    const d = await detail(keep);
    expect(d.person.sex).toBe('M');
    expect(d.names.map((n) => [n.given, n.surname, n.is_primary])).toEqual([
      ['Rowan', 'Ashdown', 1],
      ['Rowan', 'Ashdowne', 0],
    ]);
    const births = d.events.filter((e) => e.event.type === 'BIRT');
    // The chosen birth is preferred; the conflicting one becomes an alternate.
    expect(births.map((e) => [e.event.date_text, e.role.is_preferred]).sort()).toEqual([
      ['12 MAR 1880', 0],
      ['ABT 1881', 1],
    ]);
    expect(d.events.filter((e) => e.event.type === 'DEAT')).toHaveLength(1);
    // Identical facts are not duplicated.
    expect(d.events.filter((e) => e.event.type === 'RESI')).toHaveLength(1);
    // One father, one parent family (the duplicate family was folded in).
    expect(d.parentFamilies).toHaveLength(1);
    expect(d.parentFamilies[0]!.partner1!.id).toBe(father);
    expect(d.partnerFamilies.map((f) => f.partner?.id)).toEqual([spouse]);
    expect(d.tags.map((t) => t.name)).toEqual(['Smiths']);
    expect(d.notes.map((n) => n.text)).toEqual(['From the second record']);
    expect(d.citations.map((c) => c.citation.page)).toEqual(['entry 41']);
    expect(d.media).toHaveLength(1);
    expect(d.person.primary_media_id).toBe(d.media[0]!.media.id);
    const father2 = await detail(father);
    expect(father2.partnerFamilies.flatMap((f) => f.children.map((c) => c.person.id))).toEqual([
      keep,
    ]);

    const history = (await api.get(`${base}/history?limit=1`)).json();
    expect(history.items[0].label).toBe('Merge Rowan Ashdowne into Rowan Ashdown');

    await api.post(`${base}/undo`);
    expect(await status(other)).toBe(200);
    expect((await detail(other)).tags.map((t) => t.name)).toEqual(['Smiths']);
    expect((await detail(keep)).names).toHaveLength(1);
  });

  it('can take the other record’s name and sex, and makes it home if it was', async () => {
    const keep = await person('Ro', 'Ashdown', 'U');
    const other = await person('Rowan', 'Ashdown', 'M');
    await api.put(`${base}/home`, { personId: other });
    await api.post(`${base}/people/${keep}/merge`, {
      otherId: other,
      choices: { name: 'other', sex: 'other' },
    });
    const d = await detail(keep);
    expect(d.names.find((n) => n.is_primary === 1)!.given).toBe('Rowan');
    expect(d.person.sex).toBe('M');
    expect((await api.get(`${base}/home`)).json().personId).toBe(keep);
  });

  it('refuses to merge a person with themself or with a relative of theirs as both partners', async () => {
    const a = await person('A', 'X', 'M');
    expect((await api.post(`${base}/people/${a}/merge`, { otherId: a })).statusCode).toBe(400);
    expect((await api.post(`${base}/people/${a}/merge`, { otherId: ulid() })).statusCode).toBe(404);
    const b = await person('B', 'X', 'F');
    await api.post(`${base}/people/${a}/spouses`, { personId: b });
    // Merging spouses would leave a family with one person as both partners.
    expect((await api.post(`${base}/people/${a}/merge`, { otherId: b })).statusCode).toBe(409);
  });

  it('validates choices', async () => {
    const a = await person('A', 'X', 'M');
    const b = await person('A', 'X', 'M');
    for (const choices of [{ sex: 'both' }, { preferred: { 'BIRT; x': 'keep' } }, { extra: 1 }]) {
      const res = await api.post(`${base}/people/${a}/merge`, { otherId: b, choices });
      expect(res.statusCode, JSON.stringify(choices)).toBe(400);
    }
  });

  it('refuses to merge a person with an ancestor or descendant, in either order', async () => {
    const grandfather = await person('Tobias', 'Wren', 'M');
    const father = (
      await api.post(`${base}/people/${grandfather}/children`, {
        person: { sex: 'M', names: [{ given: 'Tobias', surname: 'Wren' }] },
      })
    ).json().childId as string;
    const son = (
      await api.post(`${base}/people/${father}/children`, {
        person: { sex: 'M', names: [{ given: 'Tobias', surname: 'Wren' }] },
      })
    ).json().childId as string;
    const cases: [keep: string, other: string, message: string][] = [
      [father, son, 'is a child of'],
      [son, father, 'is a parent of'],
      [grandfather, son, 'is a grandchild of'],
      [son, grandfather, 'is a grandparent of'],
    ];
    for (const [keep, other, message] of cases) {
      const res = await api.post(`${base}/people/${keep}/merge`, { otherId: other });
      expect(res.statusCode, message).toBe(409);
      expect(res.json().error.message).toContain(`Tobias Wren ${message} Tobias Wren`);
    }
    // Nothing was written.
    expect((await api.get(`${base}/history?limit=1`)).json().items[0].label).toMatch(/^Add child/);
    expect(await status(son)).toBe(200);
  });

  it('keeps the more restrictive privacy, so a privatized export still withholds it', async () => {
    const keep = await person('Rowan', 'Ashdown', 'M', [['DEAT', '1950']]);
    const other = await person('Rowan', 'Ashdown', 'M', [
      ['DEAT', '1950'],
      ['RESI', '1930', 'Hollowmere Lane'],
    ]);
    await api.patch(`${base}/people/${other}`, { privacy: 'confidential' });
    await api.post(`${base}/notes`, {
      text: 'Kept in confidence',
      owner_type: 'person',
      owner_id: other,
    });
    await api.post(`${base}/people/${keep}/merge`, { otherId: other });
    expect((await detail(keep)).person).toMatchObject({ privacy: 'confidential' });
    const privatized = (await api.get(`${base}/export.ged?privatize=true`)).body as string;
    expect(privatized).not.toContain('Hollowmere Lane');
    expect(privatized).not.toContain('Kept in confidence');
    expect(privatized).not.toContain('Ashdown');
    await api.post(`${base}/undo`);
    expect((await detail(keep)).person).toMatchObject({ privacy: 'public' });
  });

  it('drops checker dismissals that name the merged-away person', async () => {
    const keep = await person('Rowan', 'Ashdown', 'M');
    const other = await person('Rowan', 'Ashdown', 'M');
    const keys = [
      `no-sources:${keep}`,
      `no-sources:${other}`,
      `possible-duplicate:${keep}+${other}`,
    ];
    expect((await api.post(`${base}/checks/dismiss`, { keys })).statusCode).toBe(200);
    await api.post(`${base}/people/${keep}/merge`, { otherId: other });
    const left = withStore((store) =>
      store.db.prepare(`SELECT key FROM meta WHERE key LIKE 'check.dismissed:%'`).pluck().all(),
    );
    expect(left).toEqual([`check.dismissed:no-sources:${keep}`]);
    await api.post(`${base}/undo`);
    expect(
      withStore((store) =>
        store.db
          .prepare(`SELECT COUNT(*) FROM meta WHERE key LIKE 'check.dismissed:%'`)
          .pluck()
          .get(),
      ),
    ).toBe(3);
  });

  it('keeps the sources and notes of an event both people share', async () => {
    const keep = await person('Rowan', 'Ashdown', 'M');
    const other = await person('Rowan', 'Ashdown', 'M');
    const eventId = withStore(
      (store) =>
        store.transact('test rows', (tx) => {
          const census = tx.insert('event', { type: 'CENS', date_text: '1901' });
          for (const personId of [keep, other])
            tx.insert('event_role', {
              event_id: census.id,
              person_id: personId,
              role: 'principal',
            });
          const source = tx.insert('source', { title: 'Census' });
          const citation = tx.insert('citation', { source_id: source.id, page: 'piece 12' });
          tx.insert('citation_link', {
            citation_id: citation.id,
            owner_type: 'event',
            owner_id: census.id,
          });
          const note = tx.insert('note', { text: 'Listed twice' });
          tx.insert('note_link', { note_id: note.id, owner_type: 'event', owner_id: census.id });
          return census.id;
        }).result,
    );
    expect((await api.post(`${base}/people/${keep}/merge`, { otherId: other })).statusCode).toBe(
      200,
    );
    const counts = withStore((store) => ({
      roles: store.db.prepare('SELECT person_id FROM event_role WHERE event_id = ?').all(eventId),
      citations: store.db
        .prepare(`SELECT 1 FROM citation_link WHERE owner_type = 'event' AND owner_id = ?`)
        .all(eventId).length,
      notes: store.db
        .prepare(`SELECT 1 FROM note_link WHERE owner_type = 'event' AND owner_id = ?`)
        .all(eventId).length,
    }));
    expect(counts).toEqual({ roles: [{ person_id: keep }], citations: 1, notes: 1 });
  });
});

/*
 * The same man recorded twice (@I1@, @I2@), each married to @I3@ in 1875 with
 * a cited marriage, both children of @F9@.
 */
const DUPLICATES = `0 HEAD
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Tobias /Wren/
1 SEX M
1 BIRT
2 DATE 1850
1 FAMS @F1@
1 FAMC @F9@
0 @I2@ INDI
1 NAME Tobias /Wrenn/
1 SEX M
1 BIRT
2 DATE ABT 1851
1 DEAT
2 DATE 1920
1 FAMS @F2@
1 FAMC @F9@
1 NOTE From the second record
1 _XYZ kept with the record
0 @I3@ INDI
1 NAME Mabel /Stone/
1 SEX F
1 FAMS @F1@
1 FAMS @F2@
0 @I4@ INDI
1 NAME Silas /Wren/
1 SEX M
1 FAMS @F9@
0 @I5@ INDI
1 NAME Ivy /Wren/
1 FAMC @F1@
0 @I6@ INDI
1 NAME Hal /Wren/
1 FAMC @F2@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I3@
1 CHIL @I5@
1 MARR
2 DATE 1875
2 SOUR @S1@
3 PAGE entry 1
0 @F2@ FAM
1 HUSB @I2@
1 WIFE @I3@
1 CHIL @I6@
1 MARR
2 DATE 1875
2 SOUR @S1@
3 PAGE entry 2
0 @F9@ FAM
1 HUSB @I4@
1 CHIL @I1@
1 CHIL @I2@
0 @S1@ SOUR
1 TITL Parish register
0 TRLR
`;

describe('merging imported duplicates', () => {
  let keep: string;
  let other: string;
  beforeEach(async () => {
    const store = openTree(join(api.root, 'Merge.oatree'));
    try {
      await importGedcom({ bytes: DUPLICATES }, store);
      const id = (xref: string) =>
        store.db
          .prepare(`SELECT owner_id FROM raw_record WHERE xref = ? AND owner_type = 'person'`)
          .pluck()
          .get(xref) as string;
      [keep, other] = [id('@I1@'), id('@I2@')];
    } finally {
      store.close();
    }
    const res = await api.post(`${base}/people/${keep}/merge`, { otherId: other });
    expect(res.statusCode).toBe(200);
  });

  it('folds the two marriages into one, with both citations', async () => {
    const marriages = withStore((store) =>
      store.db
        .prepare(
          `SELECT e.id, (SELECT COUNT(*) FROM citation_link l
             WHERE l.owner_type = 'event' AND l.owner_id = e.id) AS citations
           FROM event e JOIN event_role r ON r.event_id = e.id
           JOIN family f ON f.id = r.family_id
           WHERE e.type = 'MARR' AND ? IN (f.partner1_id, f.partner2_id)`,
        )
        .all(keep),
    );
    expect(marriages).toEqual([{ id: expect.any(String), citations: 2 }]);
  });

  for (const version of ['5.5.1', '7'] as const) {
    it(`exports valid GEDCOM ${version} with one record for the merged person`, async () => {
      const res = await api.get(`${base}/export.ged?version=${version}`);
      expect(res.statusCode).toBe(200);
      const doc = parseGedcom(res.body);
      expect(doc.warnings).toEqual([]);
      expect(danglingPointers(doc)).toEqual([]);
      const records = (tag: string) => doc.records.filter((r) => r.tag === tag);
      expect(records('INDI')).toHaveLength(5);
      expect(records('FAM')).toHaveLength(2);
      const wrens = records('INDI').filter((r) =>
        r.children.some((c) => c.tag === 'NAME' && c.value?.startsWith('Tobias')),
      );
      expect(wrens).toHaveLength(1);
      // The merged-away record's extension line and both names survive.
      const lines = res.body as string;
      expect(lines).toContain('_XYZ kept with the record');
      expect(lines).toContain('Tobias /Wrenn/');

      const reimported = openMemoryTree();
      const result = await importGedcom({ bytes: res.body }, reimported);
      expect(result.warnings).toEqual([]);
      expect(reimported.db.prepare('SELECT COUNT(*) FROM person').pluck().get()).toBe(5);
      reimported.close();
    });
  }
});

function danglingPointers(doc: ReturnType<typeof parseGedcom>): string[] {
  const out: string[] = [];
  const visit = (n: (typeof doc.records)[number]) => {
    if (n.pointer && n.pointer !== '@VOID@' && !doc.index.has(n.pointer)) out.push(n.pointer);
    n.children.forEach(visit);
  };
  doc.records.forEach(visit);
  return out;
}
