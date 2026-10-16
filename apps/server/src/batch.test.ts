import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seed, testApi, type Seeded, type TestApi } from './test/helpers';

/* POST /api/trees/:tree/batch: several edits as one change batch (one undo step). */

let api: TestApi;
let s: Seeded;
beforeEach(async () => {
  api = await testApi();
  s = await seed(api);
});
afterEach(() => api.close());

type Detail = {
  person: { sex: string; updated_at: string };
  names: {
    id: string;
    given: string | null;
    surname: string | null;
    type: string;
    full_text: string | null;
  }[];
  tags: { name: string }[];
  parentFamilies: { link: { id: string; partner1_rel: string } }[];
};
const detail = async (id: string): Promise<Detail> =>
  (await api.get(`${s.base}/people/${id}`)).json();
const history = async () => (await api.get(`${s.base}/history`)).json();

describe('batch', () => {
  it('applies every operation in one undoable batch', async () => {
    const before = await detail(s.ada);
    const name = before.names[0]!;
    const link = before.parentFamilies[0]!.link;
    const res = await api.post(`${s.base}/batch`, {
      label: 'Edit Ada Vale',
      operations: [
        { op: 'name.update', id: name.id, name: { given: 'Adeline' } },
        { op: 'name.add', personId: s.ada, name: { given: 'Addie', type: 'aka' } },
        { op: 'person.update', id: s.ada, patch: { sex: 'X' } },
        { op: 'familyChild.update', id: link.id, patch: { partner1_rel: 'adopted' } },
        { op: 'tag.create', tag: { name: 'Research' }, attachTo: s.ada },
      ],
    });
    expect(res.statusCode).toBe(200);
    const { batchId, results } = res.json();
    expect(batchId).toEqual(expect.any(String));
    expect(results).toHaveLength(5);

    const after = await detail(s.ada);
    expect(after.person.sex).toBe('X');
    expect(after.names.map((n) => n.given)).toEqual(['Adeline', 'Addie']);
    expect(after.names[0]!.full_text).toBe('Adeline /Vale/');
    expect(after.parentFamilies[0]!.link.partner1_rel).toBe('adopted');
    expect(after.tags.map((t) => t.name)).toEqual(['Research']);

    const { items } = await history();
    expect(items[0]).toMatchObject({ id: batchId, label: 'Edit Ada Vale' });

    // One undo reverts all of it.
    await api.post(`${s.base}/undo`);
    const undone = await detail(s.ada);
    expect(undone.person.sex).toBe(before.person.sex);
    expect(undone.names.map((n) => n.given)).toEqual(['Ada']);
    expect(undone.tags).toEqual([]);
    expect(undone.parentFamilies[0]!.link.partner1_rel).toBe(link.partner1_rel);
  });

  it('rolls back everything when one operation fails', async () => {
    const before = await detail(s.ada);
    const res = await api.post(`${s.base}/batch`, {
      label: 'Broken',
      operations: [
        { op: 'person.update', id: s.ada, patch: { sex: 'X' } },
        { op: 'name.delete', id: before.names[0]!.id },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect((await detail(s.ada)).person.sex).toBe(before.person.sex);
    expect((await history()).items[0].label).not.toBe('Broken');
  });

  it('removes and re-tags people, and reports missing records', async () => {
    const tag = (await api.post(`${s.base}/tags`, { name: 'Brick wall' })).json().tag;
    let res = await api.post(`${s.base}/batch`, {
      label: 'Tags',
      operations: [{ op: 'person.tag', personId: s.ada, tagId: tag.id }],
    });
    expect((await detail(s.ada)).tags.map((t) => t.name)).toEqual(['Brick wall']);
    res = await api.post(`${s.base}/batch`, {
      label: 'Tags',
      operations: [{ op: 'person.untag', personId: s.ada, tagId: tag.id }],
    });
    expect(res.statusCode).toBe(200);
    expect((await detail(s.ada)).tags).toEqual([]);

    res = await api.post(`${s.base}/batch`, {
      label: 'Missing',
      operations: [{ op: 'name.update', id: 'NOPE', name: { given: 'x' } }],
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses operations made from stale data with 409 stale, changing nothing', async () => {
    const seen = await detail(s.ada);
    const name = seen.names[0]!;
    // The whole row, numbers and nulls included, as the Edit person dialog sends it.
    const sawName = { ...name };
    const sawPerson = { updated_at: seen.person.updated_at };
    // Timestamps have millisecond resolution; make sure the next edit gets a new one.
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Another window renames Ada after this one loaded her.
    let res = await api.post(`${s.base}/batch`, {
      label: 'Other window',
      operations: [{ op: 'name.update', id: name.id, name: { given: 'Adeline' } }],
    });
    expect(res.statusCode).toBe(200);

    for (const operation of [
      { op: 'name.update', id: name.id, name: { surname: 'Ashby' }, expect: sawName },
      { op: 'name.delete', id: name.id, expect: sawName },
    ]) {
      res = await api.post(`${s.base}/batch`, {
        label: 'Stale',
        operations: [
          { op: 'person.update', id: s.ada, patch: { sex: 'X' }, expect: sawPerson },
          operation,
        ],
      });
      expect(res.statusCode, operation.op).toBe(409);
      expect(res.json().error.code).toBe('stale');
    }
    const after = await detail(s.ada);
    expect(after.person.sex).toBe(seen.person.sex);
    expect(after.names[0]).toMatchObject({ given: 'Adeline', surname: name.surname });
    expect((await history()).items[0].label).toBe('Other window');

    // Undo puts the row back as this window saw it, so its save goes through again.
    await api.post(`${s.base}/undo`);
    res = await api.post(`${s.base}/batch`, {
      label: 'Fresh',
      operations: [
        { op: 'name.update', id: name.id, name: { surname: 'Ashby' }, expect: sawName },
        { op: 'person.update', id: s.ada, patch: { sex: 'X' }, expect: sawPerson },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect((await detail(s.ada)).names[0]).toMatchObject({ given: 'Ada', surname: 'Ashby' });
  });

  it('checks expect against the rows as the batch found them, not as earlier ops left them', async () => {
    // Ada gets a second name, so there is a primary to delete and one to promote.
    const added = await api.post(`${s.base}/people/${s.ada}/names`, {
      given: 'Addie',
      type: 'aka',
    });
    expect(added.statusCode).toBe(201);
    let seen = await detail(s.ada);
    const [primary, other] = seen.names as unknown as Record<string, unknown>[];
    expect(primary).toMatchObject({ is_primary: 1 });

    // Promoting the other name demotes the primary before its own delete runs.
    let res = await api.post(`${s.base}/batch`, {
      label: 'Swap primary',
      operations: [
        { op: 'name.update', id: other!.id, name: { is_primary: true }, expect: other },
        { op: 'name.delete', id: primary!.id, expect: primary },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await detail(s.ada)).names.map((n) => n.given)).toEqual(['Addie']);

    // A name edit and a person edit in one save: neither makes the other stale.
    seen = await detail(s.ada);
    res = await api.post(`${s.base}/batch`, {
      label: 'Name and sex',
      operations: [
        { op: 'name.update', id: seen.names[0]!.id, name: { given: 'Ada' }, expect: seen.names[0] },
        {
          op: 'person.update',
          id: s.ada,
          patch: { sex: 'X' },
          expect: { updated_at: seen.person.updated_at },
        },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('refuses a stale second operation and keeps the first one out too', async () => {
    const seen = await detail(s.ada);
    const res = await api.post(`${s.base}/batch`, {
      label: 'Half stale',
      operations: [
        { op: 'person.update', id: s.ada, patch: { sex: 'X' } },
        {
          op: 'name.update',
          id: seen.names[0]!.id,
          name: { given: 'Q' },
          expect: { given: 'Old' },
        },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect((await detail(s.ada)).person.sex).toBe(seen.person.sex);
  });

  it('checks family links (no timestamp) against the values the client saw', async () => {
    const { link } = (await detail(s.ada)).parentFamilies[0]!;
    await api.post(`${s.base}/batch`, {
      label: 'Other window',
      operations: [{ op: 'familyChild.update', id: link.id, patch: { partner1_rel: 'step' } }],
    });
    let res = await api.post(`${s.base}/batch`, {
      label: 'Stale link',
      operations: [
        {
          op: 'familyChild.update',
          id: link.id,
          patch: { partner1_rel: 'adopted' },
          expect: { partner1_rel: link.partner1_rel },
        },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('stale');
    res = await api.post(`${s.base}/batch`, {
      label: 'Fresh link',
      operations: [
        {
          op: 'familyChild.update',
          id: link.id,
          patch: { partner1_rel: 'adopted' },
          expect: { partner1_rel: 'step' },
        },
      ],
    });
    expect(res.statusCode).toBe(200);
  });

  it('validates operations', async () => {
    for (const body of [
      { label: 'x', operations: [] },
      { label: 'x', operations: [{ op: 'person.drop', id: s.ada }] },
      { label: 'x', operations: [{ op: 'person.update', id: s.ada, patch: { sex: 'Q' } }] },
      { operations: [{ op: 'person.update', id: s.ada, patch: {} }] },
      {
        label: 'x',
        operations: [{ op: 'person.update', id: s.ada, patch: {}, expect: { 'x; DROP': 1 } }],
      },
      {
        label: 'x',
        operations: [{ op: 'person.update', id: s.ada, patch: {}, expect: { nope: 1 } }],
      },
      {
        label: 'x',
        operations: [{ op: 'person.update', id: s.ada, patch: {}, expect: { constructor: 1 } }],
      },
      {
        label: 'x',
        operations: [{ op: 'person.update', id: s.ada, patch: {}, expect: { sex: ['M'] } }],
      },
    ]) {
      const res = await api.post(`${s.base}/batch`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('needs the mutation token like every write', async () => {
    const res = await api.inject({
      method: 'POST',
      url: `${s.base}/batch`,
      headers: { host: '127.0.0.1:4317' },
      payload: { label: 'x', operations: [{ op: 'person.update', id: s.ada, patch: {} }] },
    });
    expect(res.statusCode).toBe(403);
  });
});
