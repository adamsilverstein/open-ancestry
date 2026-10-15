import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seed, testApi, type Seeded, type TestApi } from './test/helpers';

let api: TestApi;
let s: Seeded;
beforeEach(async () => {
  api = await testApi();
  s = await seed(api);
});
afterEach(() => api.close());

describe('GET relationship', () => {
  it('names any pair across the whole tree, in-laws included', async () => {
    const res = await api.get(`${s.base}/relationship?from=${s.dan}&to=${s.bram}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('son-in-law');
    expect(body.relationships[0].paths[0].ids).toEqual([s.dan, s.ada, s.bram]);
    expect(body.people.map((p: { given: string }) => p.given).sort()).toEqual([
      'Ada',
      'Bram',
      'Dan',
    ]);
    const eve = (await api.get(`${s.base}/relationship?from=${s.eve}&to=${s.cora}`)).json();
    expect(eve.name).toBe('granddaughter');
  });

  it('defaults the second person to the home person and follows home changes', async () => {
    expect((await api.put(`${s.base}/home`, { personId: s.ada })).statusCode).toBe(200);
    expect((await api.get(`${s.base}/relationship?from=${s.eve}`)).json().name).toBe('daughter');
    await api.put(`${s.base}/home`, { personId: s.bram });
    expect((await api.get(`${s.base}/relationship?from=${s.eve}`)).json().name).toBe(
      'granddaughter',
    );
  });

  it('rejects unknown and malformed people', async () => {
    const missing = await api.get(
      `${s.base}/relationship?from=${s.eve}&to=01ARZ3NDEKTSV4RRFFQ69G5FAV`,
    );
    expect(missing.statusCode).toBe(404);
    expect((await api.get(`${s.base}/relationship?from=nope&to=${s.eve}`)).statusCode).toBe(404);
    expect((await api.get(`${s.base}/relationship`)).statusCode).toBe(400);
  });
});
