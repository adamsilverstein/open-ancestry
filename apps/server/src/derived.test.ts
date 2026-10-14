import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seed, testApi, type Seeded, type TestApi } from './test/helpers';

/*
 * Edits fill derived columns the way the importer does: phonetic surname
 * keys, parsed date columns, the GEDCOM name text and inferred living status.
 */

let api: TestApi;
let s: Seeded;
beforeEach(async () => {
  api = await testApi();
  s = await seed(api);
});
afterEach(() => api.close());

type Detail = {
  person: { living: string };
  names: { id: string; full_text: string | null; surname_key: string | null }[];
  events: { event: { id: string; type: string } }[];
};
const detail = async (id: string): Promise<Detail> =>
  (await api.get(`${s.base}/people/${id}`)).json();

describe('name full_text', () => {
  it('is written in GEDCOM form on create', async () => {
    const res = await api.post(`${s.base}/people`, {
      names: [{ prefix: 'Dr.', given: 'Finn Arlo', surname: 'Vale', suffix: 'Jr.' }],
    });
    const { names } = await detail(res.json().person.id);
    expect(names[0]).toMatchObject({ full_text: 'Dr. Finn Arlo /Vale/ Jr.' });
  });

  it('is recomputed from the merged row on a partial edit', async () => {
    const [name] = (await detail(s.ada)).names;
    await api.patch(`${s.base}/names/${name!.id}`, { given: 'Adeline' });
    const [after] = (await detail(s.ada)).names;
    expect(after!.full_text).toBe('Adeline /Vale/');
    expect(after!.surname_key).toBe(name!.surname_key);
    await api.post(`${s.base}/people/${s.ada}/names`, { given: 'Ada', type: 'aka' });
    expect((await detail(s.ada)).names.at(-1)!.full_text).toBe('Ada');
  });
});

describe('inferred living status', () => {
  it('turns inferred living into inferred dead when a death is added, and back on delete', async () => {
    const created = await api.post(`${s.base}/people`, {
      names: [{ given: 'Ivo', surname: 'Reed' }],
      events: [{ type: 'BIRT', date_text: '1990' }],
    });
    const id = created.json().person.id as string;
    expect((await detail(id)).person.living).toBe('inferred_living');

    const death = await api.post(`${s.base}/people/${id}/events`, {
      type: 'DEAT',
      date_text: '2020',
    });
    expect((await detail(id)).person.living).toBe('inferred_dead');

    await api.del(`${s.base}/events/${death.json().event.id}`);
    expect((await detail(id)).person.living).toBe('inferred_living');
  });

  it('infers from an edited birth date', async () => {
    const created = await api.post(`${s.base}/people`, {
      names: [{ given: 'Old', surname: 'Reed' }],
      events: [{ type: 'BIRT', date_text: '1990' }],
    });
    const id = created.json().person.id as string;
    const birth = (await detail(id)).events[0]!.event.id;
    await api.patch(`${s.base}/events/${birth}`, { date_text: '1801' });
    expect((await detail(id)).person.living).toBe('inferred_dead');
  });

  it('never overrides an explicit choice', async () => {
    const created = await api.post(`${s.base}/people`, {
      living: 'living',
      names: [{ given: 'Kept', surname: 'Reed' }],
    });
    const id = created.json().person.id as string;
    await api.post(`${s.base}/people/${id}/events`, { type: 'DEAT', date_text: '2020' });
    expect((await detail(id)).person.living).toBe('living');
  });

  it('uses relatives added later', async () => {
    const created = await api.post(`${s.base}/people`, {
      names: [{ given: 'Undated', surname: 'Reed' }],
    });
    const id = created.json().person.id as string;
    expect((await detail(id)).person.living).toBe('inferred_living');
    // Two relatives born long ago bound the birth year well past the threshold.
    await api.post(`${s.base}/people/${id}/parents`, {
      person: { names: [{ given: 'P' }], events: [{ type: 'BIRT', date_text: '1700' }] },
    });
    await api.post(`${s.base}/people/${id}/children`, {
      person: { names: [{ given: 'C' }], events: [{ type: 'BIRT', date_text: '1760' }] },
    });
    expect((await detail(id)).person.living).toBe('inferred_dead');
  });
});

describe('batch labels', () => {
  const labels = async (n = 1) =>
    ((await api.get(`${s.base}/history?limit=${n}`)).json().items as { label: string }[]).map(
      (b) => b.label,
    );

  it('name the person and the event type', async () => {
    const [name] = (await detail(s.ada)).names;
    await api.patch(`${s.base}/names/${name!.id}`, { given: 'Adeline' });
    // Named as the person was known when the edit was made.
    expect(await labels()).toEqual(['Edit name: Ada Vale']);
    const event = await api.post(`${s.base}/people/${s.ada}/events`, {
      type: 'CENS',
      date_text: '1951',
    });
    expect(await labels()).toEqual(['Add Census: Adeline Vale']);
    await api.patch(`${s.base}/events/${event.json().event.id}`, { date_text: '1952' });
    expect(await labels()).toEqual(['Edit Census: Adeline Vale']);
    await api.post(`${s.base}/people/${s.ada}/parents`, { person: { names: [{ given: 'Ida' }] } });
    expect(await labels()).toEqual(['Add parent: Adeline Vale']);
    await api.post(`${s.base}/notes`, { text: 'n', owner_type: 'person', owner_id: s.ada });
    expect(await labels()).toEqual(['Add note: Adeline Vale']);
    await api.del(`${s.base}/people/${s.eve}`);
    expect(await labels()).toEqual(['Delete person: Eve Reed']);
  });
});

describe('living after unlinking', () => {
  it('re-infers relatives when a person they depended on is deleted', async () => {
    const created = await api.post(`${s.base}/people`, {
      names: [{ given: 'Lone', surname: 'Reed' }],
    });
    const id = created.json().person.id as string;
    const parent = await api.post(`${s.base}/people/${id}/parents`, {
      person: { names: [{ given: 'P' }], events: [{ type: 'BIRT', date_text: '1700' }] },
    });
    await api.post(`${s.base}/people/${id}/children`, {
      person: { names: [{ given: 'C' }], events: [{ type: 'BIRT', date_text: '1760' }] },
    });
    expect((await detail(id)).person.living).toBe('inferred_dead');
    // With only one dated relative left, there is not enough evidence: living again.
    await api.del(`${s.base}/people/${parent.json().parentId}`);
    expect((await detail(id)).person.living).toBe('inferred_living');
  });
});
