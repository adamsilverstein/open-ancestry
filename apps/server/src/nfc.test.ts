import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seed, testApi, type Seeded, type TestApi } from './test/helpers';

const NFD = (s: string) => s.normalize('NFD');
const NFC = (s: string) => s.normalize('NFC');

let api: TestApi;
let s: Seeded;
beforeEach(async () => {
  api = await testApi();
  s = await seed(api);
});
afterEach(() => api.close());

describe('NFD input to the edit API', () => {
  it('stores names, places and notes as NFC and reuses the NFC place', async () => {
    const first = await api.post(`${s.base}/people`, {
      names: [{ given: NFC('Zoë'), surname: 'Ash' }],
      events: [{ type: 'BIRT', place: NFC('Zürich, Schweiz') }],
    });
    const second = await api.post(`${s.base}/people`, {
      names: [{ given: NFD('José'), surname: NFD('Müller') }],
      events: [{ type: 'BIRT', place: NFD('Zürich, Schweiz') }],
    });
    expect(second.statusCode).toBe(201);
    const id = second.json().person.id;
    const detail = (await api.get(`${s.base}/people/${id}`)).json();
    expect(detail.names[0]).toMatchObject({ given: NFC('José'), surname: NFC('Müller') });
    const place = (p: { events: { place: { id: string; full_name: string } }[] }) =>
      p.events[0]!.place;
    expect(place(detail).full_name).toBe(NFC('Zürich, Schweiz'));
    const firstDetail = (await api.get(`${s.base}/people/${first.json().person.id}`)).json();
    expect(place(detail).id).toBe(place(firstDetail).id);
  });

  it('normalizes a name edit', async () => {
    const [name] = (await api.get(`${s.base}/people/${s.ada}`)).json().names;
    const res = await api.patch(`${s.base}/names/${name.id}`, { given: NFD('Adà') });
    expect(res.json().name.given).toBe(NFC('Adà'));
  });

  it('finds NFC text with an NFD query', async () => {
    await api.post(`${s.base}/people`, { names: [{ given: NFC('Zoë'), surname: NFC('Müller') }] });
    const res = await api.get(`${s.base}/search?q=${encodeURIComponent(NFD('Müller'))}`);
    expect(res.json().items).toHaveLength(1);
  });
});
