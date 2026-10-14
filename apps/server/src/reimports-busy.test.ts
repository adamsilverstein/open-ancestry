import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as importPackage from '@open-ancestry/import';
import { importFile } from '@open-ancestry/import';
import { MUTATION_HEADERS, testApi, type TestApi } from './test/helpers';

// The compare is held open so the test can act while it runs.
const held = vi.hoisted(() => ({ release: () => {}, started: false, hold: true }));
vi.mock('@open-ancestry/import', async (importOriginal) => {
  const actual = await importOriginal<typeof importPackage>();
  return {
    ...actual,
    prepareReimport: async (...args: Parameters<typeof actual.prepareReimport>) => {
      if (held.hold) {
        held.started = true;
        await new Promise<void>((resolve) => (held.release = resolve));
      }
      return actual.prepareReimport(...args);
    },
  };
});

const SAMPLE = readFileSync(
  join(import.meta.dirname, '../../../fixtures/ancestry-sample.ged'),
  'utf8',
);

function multipart(content: string) {
  const boundary = '----oa-busy';
  return {
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Family.ged"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    ),
    headers: { ...MUTATION_HEADERS, 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

let api: TestApi;
beforeEach(async () => {
  held.started = false;
  held.hold = true;
  api = await testApi({ importer: importFile });
});
afterEach(() => {
  held.release();
  return api.close();
});

async function finished(id: string) {
  await vi.waitFor(async () => {
    expect(['completed', 'failed']).toContain((await api.get(`/api/jobs/${id}`)).json().state);
  });
  return (await api.get(`/api/jobs/${id}`)).json();
}

it('keeps the tree from being renamed or deleted while a re-import compares', async () => {
  const imported = await api.inject({ method: 'POST', url: '/api/import', ...multipart(SAMPLE) });
  const base = `/api/trees/${encodeURIComponent((await finished(imported.json().jobId)).tree)}`;
  const res = await api.inject({ method: 'POST', url: `${base}/reimport`, ...multipart(SAMPLE) });
  await vi.waitFor(() => expect(held.started).toBe(true));
  expect((await api.patch(base, { name: 'Other' })).statusCode).toBe(409);
  held.release();
  expect((await finished(res.json().jobId)).state).toBe('completed');
  expect((await api.patch(base, { name: 'Other' })).statusCode).toBe(200);
});

it('cancels a running compare: no review is kept and the tree is free again', async () => {
  const imported = await api.inject({ method: 'POST', url: '/api/import', ...multipart(SAMPLE) });
  const base = `/api/trees/${encodeURIComponent((await finished(imported.json().jobId)).tree)}`;
  const res = await api.inject({ method: 'POST', url: `${base}/reimport`, ...multipart(SAMPLE) });
  await vi.waitFor(() => expect(held.started).toBe(true));
  const jobId = res.json().jobId as string;
  expect((await api.del(`/api/jobs/${jobId}`)).statusCode).toBe(202);
  held.release();
  const job = await finished(jobId);
  expect(job).toMatchObject({ state: 'failed', kind: 'reimport' });
  expect(job.result ?? null).toBeNull();
  expect(job.error).toMatch(/cancel/i);
  expect((await api.patch(base, { name: 'Other' })).statusCode).toBe(200);
});

it('refuses writes from queueing the compare, and refuses applying a review while the tree is busy', async () => {
  const imported = await api.inject({ method: 'POST', url: '/api/import', ...multipart(SAMPLE) });
  const base = `/api/trees/${encodeURIComponent((await finished(imported.json().jobId)).tree)}`;
  // A first review, compared while nothing holds the tree.
  held.hold = false;
  const first = await api.inject({ method: 'POST', url: `${base}/reimport`, ...multipart(SAMPLE) });
  const { reimportId } = (await finished(first.json().jobId)).result as { reimportId: string };
  held.hold = true;
  // A second compare is queued and running: the tree is busy.
  const second = await api.inject({
    method: 'POST',
    url: `${base}/reimport`,
    ...multipart(SAMPLE),
  });
  expect((await api.post(`${base}/people`, { sex: 'U', names: [] })).statusCode).toBe(409);
  await vi.waitFor(() => expect(held.started).toBe(true));
  expect((await api.post(`/api/reimports/${reimportId}/apply`, { accept: [] })).statusCode).toBe(
    409,
  );
  held.release();
  expect((await finished(second.json().jobId)).state).toBe('completed');
  expect((await api.post(`/api/reimports/${reimportId}/apply`, { accept: [] })).statusCode).toBe(
    200,
  );
});
