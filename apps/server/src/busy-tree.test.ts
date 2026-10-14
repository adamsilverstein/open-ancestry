import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Importer } from './jobs';
import { MUTATION_HEADERS, createTestTree, testApi, type TestApi } from './test/helpers';

/*
 * Issue #96: while a tree imports, every write to it is refused with 409,
 * so nothing lands in (or is reverted with) the import's transaction. Other
 * trees stay writable.
 */

let api: TestApi;
afterEach(() => api.close());

/** An importer that holds an open transaction on the tree until released. */
function holdingImporter() {
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const importer: Importer = async (_path, store) => {
    store.db.exec('BEGIN');
    store.db
      .prepare("INSERT INTO person (id, created_at, updated_at) VALUES ('01IMPORTED', 'x', 'x')")
      .run();
    started();
    await new Promise<void>((r) => (release = r));
    store.db.exec('ROLLBACK');
    throw new Error('aborted');
  };
  return { importer, running, release: () => release() };
}

function upload(base: string) {
  const boundary = '----oa-busy';
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.ged"\r\nContent-Type: application/octet-stream\r\n\r\n0 HEAD\n0 TRLR\n\r\n--${boundary}--\r\n`,
  );
  return api.inject({
    method: 'POST',
    url: `${base}/import`,
    payload,
    headers: { ...MUTATION_HEADERS, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}

describe('writes to a tree while it imports', () => {
  it('are refused with 409 and the import is unaffected; other trees stay writable', async () => {
    const hold = holdingImporter();
    api = await testApi({ importer: hold.importer });
    const busy = await createTestTree(api, 'Busy');
    const other = await createTestTree(api, 'Other');
    const tag = (await api.post(`${busy}/tags`, { name: 'Before' })).json();
    const started = await upload(busy);
    expect(started.statusCode).toBe(202);
    const { jobId } = started.json();
    await hold.running;

    const writes = await Promise.all([
      api.post(`${busy}/people`, { names: [{ given: 'Ada' }] }),
      api.post(`${busy}/undo`),
      api.post(`${busy}/redo`),
      api.put(`${busy}/home`, { personId: null }),
      api.post(`${busy}/tags`, { name: 'During' }),
      api.patch(`${busy}/tags/${tag.tag.id}`, { name: 'Renamed' }),
      api.del(`${busy}/tags/${tag.tag.id}`),
      api.post(`${busy}/batch`, {
        label: 'Edit',
        operations: [{ op: 'tag.create', tag: { name: 'Batched' } }],
      }),
    ]);
    for (const res of writes) {
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.message).toMatch(/busy/);
    }
    // Reads still work, and other trees take writes.
    expect((await api.get(`${busy}/history`)).statusCode).toBe(200);
    expect((await api.post(`${other}/people`, { names: [{ given: 'Bo' }] })).statusCode).toBe(201);

    hold.release();
    await vi.waitFor(async () =>
      expect((await api.get(`${busy}/tags`)).json().items).toEqual([
        expect.objectContaining({ name: 'Before' }),
      ]),
    );
    const history = (await api.get(`${busy}/history`)).json();
    expect(history.items.map((b: { label: string; state: string }) => b.state)).toEqual([
      'applied',
    ]);
    expect(history.items[0].label).toMatch(/^Add tag/);
    // Once the import has ended (cleanup included), the tree takes writes again.
    await vi.waitFor(async () =>
      expect((await api.get(`/api/jobs/${jobId}`)).json().state).toBe('failed'),
    );
    expect((await api.post(`${busy}/people`, { names: [{ given: 'Ada' }] })).statusCode).toBe(201);
  });
});
