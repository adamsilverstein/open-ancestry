import { join } from 'node:path';
import { openTree, ulid } from '@open-ancestry/db';
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
  person: { id: string; sex: string; primary_media_id: string | null };
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
});
