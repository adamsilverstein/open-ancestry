import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer } from './index';
import type { Importer, ImporterOptions } from './jobs';
import { Library } from './library';
import { STALE_UPLOAD_MS, UPLOAD_PREFIX, sweepStaleUploads } from './routes/imports';
import {
  HOST,
  MUTATION_HEADERS,
  TOKEN,
  createTestTree,
  testApi,
  type TestApi,
} from './test/helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

/** A multipart/form-data body with one file field. */
function multipart(fileName: string, content: string | Buffer, field = 'file') {
  const boundary = '----oa-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    payload,
    headers: { ...MUTATION_HEADERS, 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function upload(
  api: TestApi,
  base: string,
  fileName = 'family.ged',
  content: string | Buffer = '0 HEAD\n0 TRLR\n',
) {
  return api.inject({ method: 'POST', url: `${base}/import`, ...multipart(fileName, content) });
}

/** Parses an SSE body into [event, data] pairs. */
function sse(body: string): [string, unknown][] {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? 'null';
      return [event, JSON.parse(data)];
    });
}

/** A fake importer that records its arguments and finishes when released. */
function controllableImporter() {
  const calls: { path: string; content: string; options: ImporterOptions }[] = [];
  let release: (value?: unknown) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const importer: Importer = async (path, _store, options) => {
    // Like the real importers, honor an abort that came before the work
    // started listening (a cancel during the read below), or the job never
    // ends and server shutdown waits forever.
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => reject(new Error('aborted'));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    });
    aborted.catch(() => {});
    calls.push({ path, content: await readFile(path, 'utf8'), options });
    if (options.signal.aborted) throw new Error('aborted');
    options.onProgress({ phase: 'parse', done: 1, total: 2 });
    return Promise.race([
      aborted,
      new Promise((resolve, reject) => {
        release = resolve;
        fail = reject;
      }),
    ]);
  };
  return { importer, calls, release: (v?: unknown) => release(v), fail: (e: Error) => fail(e) };
}

async function waitForJob(api: TestApi, id: string, state: string) {
  await vi.waitFor(async () => {
    expect((await api.get(`/api/jobs/${id}`)).json().state).toBe(state);
  });
  return (await api.get(`/api/jobs/${id}`)).json();
}

let api: TestApi;
afterEach(() => api.close());

describe('POST import', () => {
  it('streams the upload to a temp file, runs the importer and reports the result', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer });
    const base = await createTestTree(api);
    const res = await upload(api, base, '../../evil name.GED', '0 HEAD\n1 SOUR Ancestry\n0 TRLR\n');
    expect(res.statusCode).toBe(202);
    const { jobId, job } = res.json();
    expect(job).toMatchObject({ id: jobId, tree: 'Test', fileName: 'evil name.GED' });

    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const [call] = fake.calls;
    expect(call!.content).toContain('1 SOUR Ancestry');
    expect(call!.path).toMatch(/oa-upload-[^/]+\/upload\.ged$/);
    // Uploads never read media from local folders; a GEDZIP brings its own.
    expect(call!.options).not.toHaveProperty('mediaDir');
    const running = await waitForJob(api, jobId, 'running');
    expect(running.progress).toEqual({ phase: 'parse', done: 1, total: 2 });

    // The tree cannot be renamed or deleted mid-import.
    expect((await api.patch(base, { name: 'Other' })).statusCode).toBe(409);

    fake.release({ people: 3 });
    const done = await waitForJob(api, jobId, 'completed');
    expect(done).toMatchObject({
      result: { people: 3 },
      error: null,
      finishedAt: expect.any(String),
    });
    expect(existsSync(call!.path)).toBe(false);

    const events = sse((await api.get(`/api/jobs/${jobId}/events`)).body);
    expect(events).toEqual([['state', expect.objectContaining({ state: 'completed' })]]);
  });

  it('reports importer failures', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer });
    const base = await createTestTree(api);
    const { jobId } = (await upload(api, base)).json();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.fail(new Error('Not a GEDCOM file'));
    expect(await waitForJob(api, jobId, 'failed')).toMatchObject({ error: 'Not a GEDCOM file' });
  });

  it('streams progress over server-sent events', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer });
    const base = await createTestTree(api);
    const server = await startServer({ library: api.root, importer: fake.importer, token: TOKEN });
    try {
      const port = new URL(server.url).port;
      const headers = { ...MUTATION_HEADERS, origin: `http://127.0.0.1:${port}` };
      const form = new FormData();
      form.append('file', new Blob(['0 HEAD\n0 TRLR\n']), 'tree.ged');
      const res = await fetch(`${server.url}${base}/import`, {
        method: 'POST',
        headers: { origin: headers.origin, 'x-oa-token': TOKEN },
        body: form,
      });
      expect(res.status).toBe(202);
      const { jobId } = (await res.json()) as { jobId: string };
      await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

      const stream = await fetch(`${server.url}/api/jobs/${jobId}/events`);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      expect(stream.headers.get('content-security-policy')).toContain("default-src 'self'");
      const reader = stream.body!.getReader();
      let text = '';
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      text += decoder.decode(value);
      expect(text).toContain('"state":"running"');
      fake.calls[0]!.options.onProgress({ phase: 'write', done: 2, total: 2 });
      fake.release({ people: 0 });
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
      const events = sse(text);
      expect(events.map(([e]) => e)).toEqual(['state', 'progress', 'state']);
      expect(events[1]![1]).toEqual({ phase: 'write', done: 2, total: 2 });
      expect(events[2]![1]).toMatchObject({ state: 'completed', result: { people: 0 } });
    } finally {
      await server.close();
    }
  });

  it('aborts running imports on shutdown', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer });
    const base = await createTestTree(api);
    const { jobId } = (await upload(api, base)).json();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const jobs = api.app;
    await jobs.close();
    expect(fake.calls[0]!.options.signal.aborted).toBe(true);
    expect(jobId).toBeTruthy();
  });

  it('bounds concurrency and the queue', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer, maxQueuedImports: 1 });
    const [a, b, c] = [
      await createTestTree(api, 'A'),
      await createTestTree(api, 'B'),
      await createTestTree(api, 'C'),
    ];
    const first = (await upload(api, a)).json().jobId;
    await waitForJob(api, first, 'running');
    // A second import into a tree that is already importing is refused outright.
    expect((await upload(api, a)).statusCode).toBe(409);
    const second = await upload(api, b);
    expect(second.statusCode).toBe(202);
    expect(second.json().job.state).toBe('queued');
    const third = await upload(api, c);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('too_many_jobs');
    fake.release();
    await waitForJob(api, second.json().jobId, 'running');
    // Running is set before the importer has read its file.
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    fake.release();
  });

  it('refuses a new upload when the queue is full, before reading the body', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer, maxQueuedImports: 1, uploadLimit: 1024 });
    const [a, b, c] = [
      await createTestTree(api, 'A'),
      await createTestTree(api, 'B'),
      await createTestTree(api, 'C'),
    ];
    const first = (await upload(api, a)).json().jobId;
    await waitForJob(api, first, 'running');
    expect((await upload(api, b)).statusCode).toBe(202);
    // Over the size limit too: a 429 (not 413) shows the body was never streamed.
    const third = await upload(api, c, 'big.ged', Buffer.alloc(4096, 'x'));
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('too_many_jobs');
    const fresh = await api.inject({
      method: 'POST',
      url: '/api/import',
      ...multipart('another.ged', '0 HEAD\n0 TRLR\n'),
    });
    expect(fresh.statusCode).toBe(429);
    expect((await api.get('/api/trees')).json().trees.map((t: { id: string }) => t.id)).toEqual([
      'A',
      'B',
      'C',
    ]);
    fake.release();
  });

  it('shuts down even when a job is cancelled before its importer starts listening', async () => {
    // The queue-full test flaked with "Hook timed out" in afterEach: releasing
    // the first job let the second one start, and close() cancelled it while
    // its importer was still reading the upload. An abort that lands before
    // the importer looks at its signal must still end the job.
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer });
    const base = await createTestTree(api);
    expect((await upload(api, base)).statusCode).toBe(202);
    // The job is running and its importer is awaiting the upload's contents.
    const drained = api.app.drain().then(() => 'drained');
    const timeout = new Promise((r) => setTimeout(() => r('hung'), 3000));
    expect(await Promise.race([drained, timeout])).toBe('drained');
  });

  it('refuses an import into a tree with people before reading the body (issue #98)', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer, uploadLimit: 1024 });
    const base = await createTestTree(api);
    await api.post(`${base}/people`, { names: [{ given: 'Ada' }] });
    // Over the size limit too: a 409 (not 413) shows the body was never streamed.
    const res = await upload(api, base, 'big.ged', Buffer.alloc(4096, 'x'));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/empty tree/);
    expect(fake.calls).toHaveLength(0);
  });

  it('limits import uploads to the import size caps by default', async () => {
    const { DEFAULT_UPLOAD_LIMIT, DEFAULT_ARCHIVE_UPLOAD_LIMIT } = await import('./index');
    const { IMPORT_LIMITS } = await import('@open-ancestry/import');
    expect(DEFAULT_UPLOAD_LIMIT).toBe(IMPORT_LIMITS.maxBytes);
    expect(DEFAULT_ARCHIVE_UPLOAD_LIMIT).toBe(IMPORT_LIMITS.maxArchiveBytes);
  });

  it('lets a GEDZIP upload past the GEDCOM cap, up to the archive cap', async () => {
    // A GEDZIP with photos is far larger than its GEDCOM text, which the
    // importer caps once it has inflated it.
    const fake = controllableImporter();
    api = await testApi({
      importer: fake.importer,
      importLimits: { maxBytes: 1024, maxArchiveBytes: 8192 },
    });
    const base = await createTestTree(api);
    expect((await upload(api, base, 'big.ged', Buffer.alloc(4096, 'x'))).statusCode).toBe(413);
    const huge = await upload(api, base, 'huge.gdz', Buffer.alloc(16_384, 'x'));
    expect(huge.statusCode).toBe(413);
    // In units a person reads (issue #120).
    expect(huge.json().error.message).toBe('GEDZIP uploads are limited to 8 KB');
    expect((await api.get('/api/limits')).json()).toEqual({
      importUpload: { gedcomBytes: 1024, archiveBytes: 8192 },
      mediaUploadBytes: 1024 ** 3,
    });
    expect(fake.calls).toHaveLength(0);
    const zip = await upload(api, base, 'photos.zip', Buffer.alloc(4096, 'x'));
    expect(zip.statusCode, zip.body).toBe(202);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.release({});
    await waitForJob(api, zip.json().jobId, 'completed');
  });

  it('refuses new imports with 503 while the server drains for shutdown', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer });
    const base = await createTestTree(api);
    expect((await upload(api, base)).statusCode).toBe(202);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    // Saving: shutdown waits for it, and must not take on more work meanwhile.
    fake.calls[0]!.options.onProgress({ phase: 'commit', done: 0, total: 1 });
    const draining = api.app.drain();
    const other = await createTestTree(api, 'Other');
    for (const res of [
      await upload(api, other),
      await api.inject({
        method: 'POST',
        url: '/api/import',
        ...multipart('new.ged', '0 HEAD\n0 TRLR\n'),
      }),
    ]) {
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json().error.code).toBe('service_unavailable');
    }
    expect(fake.calls).toHaveLength(1);
    fake.release({});
    await draining;
  });

  it('enforces the upload size limit', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer, uploadLimit: 1024 });
    const base = await createTestTree(api);
    const res = await upload(api, base, 'big.ged', Buffer.alloc(4096, 'x'));
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects bad uploads', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer });
    const base = await createTestTree(api);
    const exe = await upload(api, base, 'tree.exe');
    expect(exe.statusCode).toBe(415);
    const json = await api.post(`${base}/import`, { file: 'x' });
    expect(json.statusCode).toBe(415);
    const noFile = await api.inject({
      method: 'POST',
      url: `${base}/import`,
      headers: { ...MUTATION_HEADERS, 'content-type': 'multipart/form-data; boundary=b' },
      payload: '--b--\r\n',
    });
    expect(noFile.statusCode).toBe(400);
    expect((await upload(api, '/api/trees/Missing')).statusCode).toBe(404);
    const unauthenticated = await api.inject({
      method: 'POST',
      url: `${base}/import`,
      ...multipart('a.ged', 'x'),
      headers: { host: HOST },
    });
    expect(unauthenticated.statusCode).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it('answers 501 without an importer', async () => {
    api = await testApi();
    const base = await createTestTree(api);
    const res = await upload(api, base);
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('not_implemented');
  });
});

describe('GET jobs', () => {
  it('404s unknown jobs and 400s malformed ids', async () => {
    api = await testApi();
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await api.get(`/api/jobs/${id}`)).statusCode).toBe(404);
    expect((await api.get(`/api/jobs/${id}/events`)).statusCode).toBe(404);
    expect((await api.get('/api/jobs/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('POST /api/import (new tree owned by the server)', () => {
  const importNew = (fileName = 'Vale Family.ged', content = '0 HEAD\n0 TRLR\n') =>
    api.inject({ method: 'POST', url: '/api/import', ...multipart(fileName, content) });

  /** An importer that adds a person, like a real import. */
  const addsPerson: Importer = async (_path, store) => {
    store.transact('import', (tx) => tx.insert('person', {}));
    return { people: 1 };
  };

  it('creates a tree named after the file and hands it over on success', async () => {
    api = await testApi({ importer: addsPerson });
    const res = await importNew('../x/Vale Family.ged');
    expect(res.statusCode).toBe(202);
    const { jobId, job } = res.json();
    expect(job).toMatchObject({ tree: 'Vale Family', createdTree: true });
    await waitForJob(api, jobId, 'completed');
    const tree = (await api.get('/api/trees/Vale%20Family')).json().tree;
    expect(tree.peopleCount).toBe(1);
    const second = (await importNew()).json();
    expect(second.job.tree).toBe('Vale Family 2');
    await waitForJob(api, second.jobId, 'completed');
    // Once handed over, nothing marks the trees as removable.
    const library = new Library(api.root);
    expect(library.sweepInterruptedImports(0)).toEqual([]);
  });

  it('removes the tree it created when the import fails', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer });
    const { jobId, job } = (await importNew('Redo.ged')).json();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.fail(new Error('The file does not look like GEDCOM'));
    expect(await waitForJob(api, jobId, 'failed')).toMatchObject({ createdTree: true });
    expect(existsSync(`${api.root}/${job.tree}.oatree`)).toBe(false);
    expect((await api.get('/api/trees')).json().trees).toEqual([]);
  });

  it('cancels with DELETE /api/jobs/:id and removes the tree it created', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer });
    const { jobId, job } = (await importNew('Cancel me.ged')).json();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const unauthenticated = await api.inject({
      method: 'DELETE',
      url: `/api/jobs/${jobId}`,
      headers: { host: HOST },
    });
    expect(unauthenticated.statusCode).toBe(403);

    const cancelled = await api.del(`/api/jobs/${jobId}`);
    expect(cancelled.statusCode).toBe(202);
    expect(cancelled.json().job.id).toBe(jobId);
    expect(fake.calls[0]!.options.signal.aborted).toBe(true);
    expect(await waitForJob(api, jobId, 'failed')).toMatchObject({
      error: 'aborted',
      cancelled: true,
    });
    expect(existsSync(`${api.root}/${job.tree}.oatree`)).toBe(false);
    expect(existsSync(fake.calls[0]!.path)).toBe(false);

    expect((await api.del(`/api/jobs/${jobId}`)).statusCode).toBe(409);
    expect((await api.del('/api/jobs/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('answers 409 to a cancel once the import is finalizing or saving', async () => {
    let release!: () => void;
    const finalizing: Importer = async (_path, store, { onProgress }) => {
      onProgress({ phase: 'finalize', done: 0, total: 1 });
      await new Promise<void>((r) => (release = r));
      store.transact('import', (tx) => tx.insert('person', {}));
      return { people: 1 };
    };
    api = await testApi({ importer: finalizing });
    const { jobId, job } = (await importNew('Late.ged')).json();
    await vi.waitFor(async () =>
      expect((await api.get(`/api/jobs/${jobId}`)).json().progress).toMatchObject({
        phase: 'finalize',
      }),
    );
    const late = await api.del(`/api/jobs/${jobId}`);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toMatch(/can no longer be cancelled/);
    release();
    expect(await waitForJob(api, jobId, 'completed')).toMatchObject({ cancelled: false });
    expect(existsSync(`${api.root}/${job.tree}.oatree`)).toBe(true);
  });

  it('aborts imports and cleans up on shutdown, even with an event stream open', async () => {
    const fake = controllableImporter();
    api = await testApi(); // keeps afterEach's close happy; this test runs its own server
    const root = makeTempDir('oa-lib-');
    const server = await startServer({ library: root, importer: fake.importer, token: TOKEN });
    const origin = server.url;
    const form = new FormData();
    form.append('file', new Blob(['0 HEAD\n0 TRLR\n']), 'Shutdown.ged');
    const res = await fetch(`${origin}/api/import`, {
      method: 'POST',
      headers: { origin, 'x-oa-token': TOKEN },
      body: form,
    });
    const { jobId, job } = (await res.json()) as { jobId: string; job: { tree: string } };
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const stream = await fetch(`${origin}/api/jobs/${jobId}/events`);
    const reader = stream.body!.getReader();
    await reader.read();

    const started = performance.now();
    await server.close();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(fake.calls[0]!.options.signal.aborted).toBe(true);
    expect(existsSync(join(root, `${job.tree}.oatree`))).toBe(false);
    expect(existsSync(fake.calls[0]!.path)).toBe(false);
    await reader.cancel().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it('never removes a tree re-created under the same name, or one it did not create', async () => {
    api = await testApi();
    const library = new Library(api.root);
    const marker = 'marker-of-a-failed-import';
    const id = library.createForImport('Redo.ged', marker);
    expect(library.discardFailedImport(id, marker)).toBe(true);
    // Re-created by a later import with its own marker, and filled.
    const again = library.createForImport('Redo.ged', 'another-import');
    expect(again).toBe(id);
    library.open(again).transact('add', (tx) => tx.insert('person', {}));
    expect(library.discardFailedImport(again, marker)).toBe(false);
    expect(library.discardFailedImport(again, 'another-import')).toBe(false);
    expect(library.exists(again)).toBe(true);
    // A tree the user made has no marker at all.
    library.create('Mine');
    expect(library.discardFailedImport('Mine', marker)).toBe(false);
    library.closeAll();
  });

  it('keeps an existing tree when importing into it fails', async () => {
    api = await testApi({
      importer: async () => {
        throw new Error('Imports go into a new, empty tree');
      },
    });
    const base = await createTestTree(api, 'Populated');
    const { jobId, job } = (await upload(api, base)).json();
    expect(job.createdTree).toBe(false);
    await waitForJob(api, jobId, 'failed');
    expect((await api.get(base)).statusCode).toBe(200);
  });

  it('removes the tree when the import is cancelled before it runs', async () => {
    const fake = controllableImporter();
    api = await testApi({ importer: fake.importer });
    await importNew('First.ged');
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const queued = (await importNew('Second.ged')).json();
    expect(existsSync(`${api.root}/Second.oatree`)).toBe(true);
    await api.app.close();
    expect(existsSync(`${api.root}/First.oatree`)).toBe(false);
    expect(existsSync(`${api.root}/Second.oatree`)).toBe(false);
    expect(queued.job.state).toBe('queued');
  });
});

describe('startup sweeps', () => {
  it('removes old, empty trees of interrupted imports and nothing else', async () => {
    api = await testApi();
    const library = new Library(api.root);
    library.createForImport('Interrupted.ged', 'm1');
    const kept = library.createForImport('Filled.ged', 'm2');
    library.open(kept).transact('add', (tx) => tx.insert('person', {}));
    library.create('Users own');
    expect(library.sweepInterruptedImports(60_000)).toEqual([]);
    expect(library.sweepInterruptedImports(0, Date.now() + 1000)).toEqual(['Interrupted']);
    expect(library.list().map((t) => t.id)).toEqual(['Filled', 'Users own']);
    library.closeAll();
  });

  it('removes stale upload folders only', async () => {
    api = await testApi();
    const dir = makeTempDir('oa-sweep-');
    await mkdir(join(dir, `${UPLOAD_PREFIX}old`));
    await mkdir(join(dir, `${UPLOAD_PREFIX}fresh`));
    await mkdir(join(dir, 'unrelated-old'));
    const past = new Date(Date.now() - STALE_UPLOAD_MS - 60_000);
    await utimes(join(dir, `${UPLOAD_PREFIX}old`), past, past);
    await utimes(join(dir, 'unrelated-old'), past, past);
    expect(await sweepStaleUploads(Date.now(), dir)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual([`${UPLOAD_PREFIX}fresh`, 'unrelated-old']);
  });

  it('also sweeps stale photo-attach folders, and never follows a link (L5, #267)', async () => {
    api = await testApi();
    const dir = makeTempDir('oa-sweep-');
    const past = new Date(Date.now() - STALE_UPLOAD_MS - 60_000);
    await mkdir(join(dir, 'oa-attach-old'));
    await utimes(join(dir, 'oa-attach-old'), past, past);
    // A link named like an upload folder is not a folder of ours: left alone.
    const target = makeTempDir('oa-sweep-target-');
    await writeFile(join(target, 'keep.txt'), 'keep');
    await utimes(target, past, past);
    await symlink(target, join(dir, `${UPLOAD_PREFIX}link`));
    expect(await sweepStaleUploads(Date.now(), dir)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual([`${UPLOAD_PREFIX}link`]);
    expect(await readdir(target)).toEqual(['keep.txt']);
  });
});
