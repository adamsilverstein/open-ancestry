import { fromNeighborhood, layoutFamily } from '@open-ancestry/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seed, testApi, type Seeded, type TestApi } from './test/helpers';

let api: TestApi;
let s: Seeded;
beforeEach(async () => {
  api = await testApi();
  s = await seed(api);
});
afterEach(() => api.close());

const names = (items: { given: string }[]) => items.map((p) => p.given);

describe('GET people', () => {
  it('lists people sorted and paginated with a total', async () => {
    const res = await api.get(`${s.base}/people?sort=given&dir=asc&limit=2&offset=1`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(5);
    expect(names(body.items)).toEqual(['Bram', 'Cora']);
    const byBirth = (await api.get(`${s.base}/people?sort=birth&dir=desc`)).json();
    expect(names(byBirth.items)).toEqual(['Eve', 'Ada', 'Dan', 'Cora', 'Bram']);
  });

  it('filters by sex, living status and tag', async () => {
    expect(names((await api.get(`${s.base}/people?sex=M&sort=given`)).json().items)).toEqual([
      'Bram',
      'Dan',
    ]);
    expect((await api.get(`${s.base}/people?living=dead,inferred_dead`)).json().total).toBe(0);
    expect((await api.get(`${s.base}/people?living=unknown`)).json().total).toBe(5);
    const tag = (await api.post(`${s.base}/tags`, { name: 'Research' })).json().tag;
    await api.post(`${s.base}/people/${s.cora}/tags`, { tagId: tag.id });
    expect(names((await api.get(`${s.base}/people?tag=${tag.id}`)).json().items)).toEqual(['Cora']);
  });

  it('rejects invalid query parameters', async () => {
    for (const query of [
      'sort=age',
      'dir=up',
      'sex=Q',
      'limit=0',
      'limit=5000',
      'offset=-1',
      'living=sleeping',
      'living=Living',
    ]) {
      const res = await api.get(`${s.base}/people?${query}`);
      expect(res.statusCode, query).toBe(400);
      expect(['validation_failed', 'bad_request']).toContain(res.json().error.code);
    }
  });
});

describe('GET person', () => {
  it('returns the detail with names, timeline and families', async () => {
    const res = await api.get(`${s.base}/people/${s.ada}`);
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.summary).toMatchObject({ id: s.ada, given: 'Ada', surname: 'Vale' });
    expect(detail.summary.birth).toMatchObject({
      dateText: '5 SEP 1941',
      place: 'Harlow, Essex, England',
    });
    expect(detail.events[0].event).toMatchObject({ type: 'BIRT', date_sort: 19410905 });
    expect(detail.parentFamilies[0].partner1.given).toBe('Bram');
    expect(detail.parentFamilies[0].partner2.given).toBe('Cora');
    expect(detail.partnerFamilies[0].partner.given).toBe('Dan');
    expect(detail.partnerFamilies[0].children[0].person.given).toBe('Eve');
  });

  it('returns a summary', async () => {
    const res = await api.get(`${s.base}/people/${s.eve}/summary`);
    expect(res.json()).toMatchObject({ id: s.eve, given: 'Eve', surname: 'Reed', sex: 'F' });
  });

  it('answers 404 for unknown people and 400 for malformed ids', async () => {
    for (const url of [
      `${s.base}/people/01NOPE`,
      `${s.base}/people/01NOPE/summary`,
      `${s.base}/families/01NOPE`,
    ]) {
      const res = await api.get(url);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
    expect((await api.get(`${s.base}/people/a..b`)).statusCode).toBe(400);
  });
});

describe('GET family', () => {
  it('returns partners, children and events', async () => {
    await api.post(`${s.base}/families/${s.marriage}/events`, {
      type: 'MARR',
      date_text: '1962',
      place: 'Harlow, Essex, England',
    });
    const family = (await api.get(`${s.base}/families/${s.marriage}`)).json();
    expect(family.family.relationship_type).toBe('married');
    expect(family.partner1.given).toBe('Ada');
    expect(family.partner2.given).toBe('Dan');
    expect(family.children.map((c: { person: { given: string } }) => c.person.given)).toEqual([
      'Eve',
    ]);
    expect(family.events[0]).toMatchObject({ type: 'MARR', place: 'Harlow, Essex, England' });
  });
});

describe('GET neighborhood', () => {
  it('returns the graph slice around the focus', async () => {
    const res = await api.get(`${s.base}/neighborhood?focus=${s.ada}&up=1&down=1`);
    expect(res.statusCode).toBe(200);
    const n = res.json();
    expect(n.focusId).toBe(s.ada);
    expect(n.people.map((p: { given: string }) => p.given).sort()).toEqual([
      'Ada',
      'Bram',
      'Cora',
      'Dan',
      'Eve',
    ]);
    expect(n.families).toHaveLength(2);
    expect(n.children).toHaveLength(2);
    expect(n).toMatchObject({ moreUp: [], moreDown: [], truncated: false });
  });

  it('feeds the layout engine unchanged', async () => {
    const n = (await api.get(`${s.base}/neighborhood?focus=${s.ada}&up=2&down=2`)).json();
    const graph = fromNeighborhood(n);
    const people =
      graph.people instanceof Map ? [...graph.people.values()] : Object.values(graph.people);
    expect(people.map((p) => p.name).sort()).toEqual([
      'Ada Vale',
      'Bram Vale',
      'Cora Vale',
      'Dan Reed',
      'Eve Reed',
    ]);
    expect(graph.families).toHaveLength(2);
    const layout = layoutFamily(graph, s.ada);
    expect(JSON.stringify(layout)).toContain(s.eve);
  });

  it('limits generations', async () => {
    const n = (await api.get(`${s.base}/neighborhood?focus=${s.eve}&up=0&down=0`)).json();
    expect(n.people.map((p: { id: string }) => p.id)).toEqual([s.eve]);
    expect(n.moreUp).toEqual([s.eve]);
  });

  it('defaults the focus to the home person', async () => {
    expect((await api.get(`${s.base}/neighborhood`)).json().error.code).toBe('bad_request');
    await api.put(`${s.base}/home`, { personId: s.cora });
    expect((await api.get(`${s.base}/neighborhood`)).json().focusId).toBe(s.cora);
  });

  it('validates the query', async () => {
    expect((await api.get(`${s.base}/neighborhood?focus=01NOPE`)).statusCode).toBe(404);
    expect((await api.get(`${s.base}/neighborhood?focus=${s.ada}&up=11`)).statusCode).toBe(400);
    expect((await api.get(`${s.base}/neighborhood?focus=${s.ada}&down=-1`)).statusCode).toBe(400);
  });
});

describe('GET search', () => {
  it('finds people by name prefix, place and year', async () => {
    const given = (q: string) =>
      api
        .get(`${s.base}/search?q=${encodeURIComponent(q)}`)
        .then((r) => names(r.json().items.map((i: { person: unknown }) => i.person)));
    expect(await given('ada va')).toEqual(['Ada']);
    expect((await given('reed')).sort()).toEqual(['Dan', 'Eve']);
    expect(await given('harlow')).toEqual(['Ada']);
    expect(await given('1965')).toEqual(['Eve']);
    expect(await given('')).toEqual([]);
  });

  it('matches surnames that sound alike', async () => {
    const res = await api.get(`${s.base}/search?q=Vail`);
    const found = res
      .json()
      .items.map((i: { person: { given: string } }) => i.person.given)
      .sort();
    expect(found).toEqual(['Ada', 'Bram', 'Cora']);
  });

  it('combines given names, sounds-alike surnames and approximate years', async () => {
    const search = async (q: string) =>
      (await api.get(`${s.base}/search?q=${encodeURIComponent(q)}`)).json().items as {
        person: { given: string };
        match: string;
      }[];
    expect((await search('ada vail')).map((i) => [i.person.given, i.match])).toEqual([
      ['Ada', 'phonetic'],
    ]);
    expect((await search('vale 1942')).map((i) => [i.person.given, i.match])).toEqual([
      ['Ada', 'prefix'],
    ]);
    const ranked = await search('vale');
    expect(ranked.every((i) => i.match === 'exact')).toBe(true);
  });

  it('limits results and requires q', async () => {
    expect((await api.get(`${s.base}/search?q=vale&limit=1`)).json().items).toHaveLength(1);
    expect((await api.get(`${s.base}/search`)).statusCode).toBe(400);
    expect((await api.get(`${s.base}/search?q=${'x'.repeat(201)}`)).statusCode).toBe(400);
  });
});

describe('tags, home and export', () => {
  it('lists tags with person counts', async () => {
    const tag = (
      await api.post(`${s.base}/tags`, {
        name: 'Brick wall',
        category: 'Research',
        color: '#cc3300',
      })
    ).json().tag;
    await api.post(`${s.base}/people/${s.ada}/tags`, { tagId: tag.id });
    expect((await api.get(`${s.base}/tags`)).json().items).toEqual([
      expect.objectContaining({ id: tag.id, name: 'Brick wall', category: 'Research', people: 1 }),
    ]);
  });

  it('gets and sets the home person', async () => {
    expect((await api.get(`${s.base}/home`)).json()).toEqual({ personId: null, person: null });
    const set = await api.put(`${s.base}/home`, { personId: s.ada });
    expect(set.json()).toEqual({ batchId: expect.any(String), personId: s.ada });
    expect((await api.get(`${s.base}/home`)).json().person.given).toBe('Ada');
    expect((await api.get(s.base)).json().tree.homePersonId).toBe(s.ada);
    expect((await api.put(`${s.base}/home`, { personId: '01NOPE' })).statusCode).toBe(404);
    expect((await api.put(`${s.base}/home`, { personId: null })).json().personId).toBeNull();
    expect((await api.get(`${s.base}/home`)).json().personId).toBeNull();
  });

  it('exports the tree as open-ancestry JSON', async () => {
    const res = await api.get(`${s.base}/export.json`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''Test.json");
    const doc = res.json();
    expect(doc.format).toBe('open-ancestry');
    expect(doc.tables.person).toHaveLength(5);
  });
});

describe('caching and compression', () => {
  it('sends an ETag and answers 304 when it matches', async () => {
    const first = await api.get(`${s.base}/people/${s.ada}`);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"/);
    const again = await api.get(`${s.base}/people/${s.ada}`, { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('compresses JSON over 1KB with brotli or gzip', async () => {
    const br = await api.get(`${s.base}/people/${s.ada}`, { 'accept-encoding': 'br' });
    expect(br.headers['content-encoding']).toBe('br');
    const gzip = await api.get(`${s.base}/people/${s.ada}`, { 'accept-encoding': 'gzip' });
    expect(gzip.headers['content-encoding']).toBe('gzip');
    const small = await api.get('/api/health', { 'accept-encoding': 'br, gzip' });
    expect(small.headers['content-encoding']).toBeUndefined();
  });
});
