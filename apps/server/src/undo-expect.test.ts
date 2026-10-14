import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seed, testApi, type Seeded, type TestApi } from './test/helpers';

let api: TestApi;
let s: Seeded;
beforeEach(async () => {
  api = await testApi();
  s = await seed(api);
});
afterEach(() => api.close());

describe('POST /undo?expect=<batch>', () => {
  it('undoes the expected batch when it is still the newest', async () => {
    const created = (await api.post(`${s.base}/people`, { names: [{ given: 'Lea' }] })).json();
    const res = await api.post(`${s.base}/undo?expect=${created.batchId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().batch).toMatchObject({ id: created.batchId, state: 'undone' });
  });

  it('refuses, and changes nothing, once a newer batch exists', async () => {
    const created = (await api.post(`${s.base}/people`, { names: [{ given: 'Lea' }] })).json();
    const renamed = await api.patch(`${s.base}/people/${s.ada}`, { sex: 'X' });
    expect(renamed.statusCode).toBe(200);
    const res = await api.post(`${s.base}/undo?expect=${created.batchId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'conflict' });
    // Neither the newer edit nor the expected batch was undone.
    expect((await api.get(`${s.base}/people/${s.ada}`)).json().person.sex).toBe('X');
    expect((await api.get(`${s.base}/people/${created.person.id}`)).statusCode).toBe(200);
  });

  it('rejects a malformed batch id', async () => {
    expect((await api.post(`${s.base}/undo?expect=${encodeURIComponent('../x')}`)).statusCode).toBe(
      400,
    );
  });
});
