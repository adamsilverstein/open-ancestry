import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer } from './index';
import type { Importer, ImporterOptions } from './jobs';
import {
  HOST,
  MUTATION_HEADERS,
  TOKEN,
  createTestTree,
  testApi,
  type TestApi,
} from './test/helpers';

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
    calls.push({ path, content: await readFile(path, 'utf8'), options });
    options.onProgress({ phase: 'parse', done: 1, total: 2 });
    return new Promise((resolve, reject) => {
      release = resolve;
      fail = reject;
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
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
    expect(call!.options.mediaDir).toBe(`${api.root}/Test.oatree/media`);
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
    const base = await createTestTree(api);
    const first = (await upload(api, base)).json().jobId;
    await waitForJob(api, first, 'running');
    const second = await upload(api, base);
    expect(second.statusCode).toBe(202);
    expect(second.json().job.state).toBe('queued');
    const third = await upload(api, base);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('too_many_jobs');
    fake.release();
    await waitForJob(api, second.json().jobId, 'running');
    expect(fake.calls).toHaveLength(2);
    fake.release();
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
