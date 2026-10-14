import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seed, testApi, type Seeded, type TestApi } from './test/helpers';

/* Tag management (#57): categories through batches, and a tag's people. */

let api: TestApi;
let s: Seeded;
beforeEach(async () => {
  api = await testApi();
  s = await seed(api);
});
afterEach(() => api.close());

const tags = async () =>
  (await api.get(`${s.base}/tags`)).json().items as {
    id: string;
    name: string;
    category: string;
    color: string | null;
    people: number;
  }[];
const create = async (name: string, category: string) =>
  (await api.post(`${s.base}/tags`, { name, category })).json().tag.id as string;

describe('tag management', () => {
  it('renames a category across its tags in one undoable batch', async () => {
    const a = await create('Brick wall', 'Research');
    const b = await create('To do', 'Research');
    await create('Veteran', 'Military');
    const res = await api.post(`${s.base}/batch`, {
      label: 'Rename category: Research',
      operations: [a, b].map((id) => ({
        op: 'tag.update',
        id,
        patch: { category: 'Open questions' },
      })),
    });
    expect(res.statusCode).toBe(200);
    expect((await tags()).map((t) => [t.name, t.category])).toEqual([
      ['Veteran', 'Military'],
      ['Brick wall', 'Open questions'],
      ['To do', 'Open questions'],
    ]);
    await api.post(`${s.base}/undo`);
    expect((await tags()).filter((t) => t.category === 'Research')).toHaveLength(2);
  });

  it('recolors and deletes tags through batches, removing their links', async () => {
    const a = await create('Brick wall', 'Research');
    await api.post(`${s.base}/people/${s.ada}/tags`, { tagId: a });
    await api.post(`${s.base}/batch`, {
      label: 'Recolor tag: Brick wall',
      operations: [{ op: 'tag.update', id: a, patch: { color: 'tag-3' } }],
    });
    expect((await tags())[0]).toMatchObject({ color: 'tag-3', people: 1 });
    await api.post(`${s.base}/batch`, {
      label: 'Delete category: Research',
      operations: [{ op: 'tag.delete', id: a }],
    });
    expect(await tags()).toEqual([]);
    expect((await api.get(`${s.base}/people/${s.ada}`)).json().tags).toEqual([]);
    await api.post(`${s.base}/undo`);
    expect((await api.get(`${s.base}/people/${s.ada}`)).json().tags).toHaveLength(1);
  });

  it("lists a tag's people", async () => {
    const a = await create('Smiths', '');
    await api.post(`${s.base}/people/${s.ada}/tags`, { tagId: a });
    await api.post(`${s.base}/people/${s.eve}/tags`, { tagId: a });
    const res = await api.get(`${s.base}/tags/${a}/people`);
    expect(res.json().personIds.sort()).toEqual([s.ada, s.eve].sort());
    expect((await api.get(`${s.base}/tags/NOPE/people`)).statusCode).toBe(404);
  });
});
