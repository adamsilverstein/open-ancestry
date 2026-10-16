import { join } from 'node:path';
import Database from 'better-sqlite3';
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
      expect(res.json().error).toMatchObject({
        code: 'busy',
        message: expect.stringMatching(/busy/),
      });
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

describe('a tree another connection is writing', () => {
  it('answers a write with 409 at once instead of waiting on the lock', async () => {
    // The worker imports on its own connection; if a write ever got past the
    // busy guard, SQLITE_BUSY must come back fast as a 409, not a 500 after
    // the event loop sat in busy_timeout.
    api = await testApi();
    const base = await createTestTree(api, 'Locked');
    expect((await api.post(`${base}/tags`, { name: 'Before' })).statusCode).toBe(201);
    const other = new Database(join(api.root, 'Locked.oatree', 'tree.sqlite'));
    try {
      other.exec('BEGIN IMMEDIATE');
      const started = performance.now();
      const res = await api.post(`${base}/tags`, { name: 'During' });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'busy',
        message: expect.stringMatching(/busy/),
      });
      other.exec('ROLLBACK');
    } finally {
      other.close();
    }
    expect((await api.post(`${base}/tags`, { name: 'After' })).statusCode).toBe(201);
  });
});

describe('tree ids that differ only in case or Unicode form', () => {
  it('share the busy guard and one connection, or are not found', async () => {
    const hold = holdingImporter();
    api = await testApi({ importer: hold.importer });
    const cafe = await createTestTree(api, 'Caf\u00e9');
    const started = await upload(cafe);
    expect(started.statusCode).toBe(202);
    await hold.running;

    try {
      // NFD spelling of the same name: the same tree, so it is busy too.
      const nfd = `/api/trees/${encodeURIComponent('Cafe\u0301')}`;
      const write = await api.post(`${nfd}/tags`, { name: 'Sneaky' });
      expect(write.statusCode, write.body).toBe(409);
      // Another case is not this tree's id, even where the file system would open it.
      const upper = `/api/trees/${encodeURIComponent('CAF\u00c9')}`;
      expect((await api.post(`${upper}/tags`, { name: 'Sneaky' })).statusCode).toBe(404);
      expect((await api.get(`${upper}/tags`)).statusCode).toBe(404);
    } finally {
      hold.release();
    }
  });
});
