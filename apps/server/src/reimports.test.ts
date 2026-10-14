import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importFile } from '@open-ancestry/import';
import { MUTATION_HEADERS, testApi, type TestApi } from './test/helpers';

const SAMPLE = readFileSync(
  join(import.meta.dirname, '../../../fixtures/ancestry-sample.ged'),
  'utf8',
);

/** The sample as a later export: renumbered xrefs, one refined birth, one new child. */
function laterSample() {
  return SAMPLE.replace('2 DATE Abt. 1842', '2 DATE 12 MAR 1842')
    .replace(
      '0 @F1@ FAM',
      [
        '0 @I27@ INDI',
        '1 NAME Noah /Ashgrove/',
        '1 BIRT',
        '2 DATE 1992',
        '1 FAMC @F9@',
        '0 @F1@ FAM',
      ].join('\n'),
    )
    .replace('1 CHIL @I24@', '1 CHIL @I24@\n1 CHIL @I27@')
    .replace(/@([A-Z]+)(\d+)@/g, (_, p: string, n: string) => `@${p}${Number(n) + 100}@`);
}

function multipart(fileName: string, content: string) {
  const boundary = '----oa-reimport';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { ...MUTATION_HEADERS, 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

let api: TestApi;

async function waitForJob(id: string) {
  await vi.waitFor(async () => {
    expect(['completed', 'failed']).toContain((await api.get(`/api/jobs/${id}`)).json().state);
  });
  return (await api.get(`/api/jobs/${id}`)).json();
}

async function importedTree() {
  const res = await api.inject({
    method: 'POST',
    url: '/api/import',
    ...multipart('Family.ged', SAMPLE),
  });
  const job = await waitForJob(res.json().jobId);
  expect(job.state).toBe('completed');
  return `/api/trees/${encodeURIComponent(job.tree)}`;
}

async function startReimport(base: string, content = laterSample()) {
  const res = await api.inject({
    method: 'POST',
    url: `${base}/reimport`,
    ...multipart('Family 2026.ged', content),
  });
  expect(res.statusCode).toBe(202);
  expect(res.json().job).toMatchObject({ kind: 'reimport', fileName: 'Family 2026.ged' });
  const job = await waitForJob(res.json().jobId);
  expect(job.state).toBe('completed');
  return job.result as { reimportId: string; counts: Record<string, number> };
}

beforeEach(async () => {
  api = await testApi({ importer: importFile });
});
afterEach(() => api.close());

describe('re-import', () => {
  it('compares an updated export and returns the review', async () => {
    const base = await importedTree();
    const { reimportId, counts } = await startReimport(base);
    expect(counts).toMatchObject({ matched: 26, newPeople: 1, missingPeople: 0 });
    const review = (await api.get(`/api/reimports/${reimportId}`)).json();
    expect(review).toMatchObject({ id: reimportId, tree: 'Family', fileName: 'Family 2026.ged' });
    expect(review.source).toMatchObject({ system: 'Ancestry.com Family Trees' });
    const thaddeus = review.diff.people.find(
      (p: { name: string }) => p.name === 'Thaddeus Ashgrove',
    );
    expect(thaddeus.changes[0]).toMatchObject({
      kind: 'fact.change',
      before: { date: 'Abt. 1842' },
      after: { date: '12 MAR 1842' },
    });
    // Comparing writes nothing.
    expect((await api.get(`${base}/history`)).json().items ?? []).toHaveLength(0);
  });

  it('applies the accepted changes as one undoable batch', async () => {
    const base = await importedTree();
    const { reimportId } = await startReimport(base);
    const review = (await api.get(`/api/reimports/${reimportId}`)).json();
    const accept = review.diff.people.flatMap(
      (p: { changes: { id: string; defaultAccept: boolean }[] }) =>
        p.changes.filter((c) => c.defaultAccept).map((c) => c.id),
    );
    const applied = await api.post(`/api/reimports/${reimportId}/apply`, { accept });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ applied: accept.length, blocked: [] });
    expect((await api.get(base)).json().tree.peopleCount).toBe(27);
    // The session is used up.
    expect((await api.get(`/api/reimports/${reimportId}`)).statusCode).toBe(404);
    const undo = await api.post(`${base}/undo`);
    expect(undo.json().batch.label).toBe('Re-import Family 2026.ged');
    expect((await api.get(base)).json().tree.peopleCount).toBe(26);
  });

  it('refuses a stale review and validates the request', async () => {
    const base = await importedTree();
    const { reimportId } = await startReimport(base);
    expect(
      (await api.post(`/api/reimports/${reimportId}/apply`, { accept: [], everything: true }))
        .statusCode,
    ).toBe(400);
    const people = (await api.get(`${base}/people?limit=1`)).json();
    await api.patch(`${base}/people/${people.items[0].id}`, { sex: 'X' });
    const stale = await api.post(`/api/reimports/${reimportId}/apply`, { accept: [] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('conflict');
    expect(
      (await api.post(`/api/reimports/00000000-0000-4000-8000-000000000000/apply`, { accept: [] }))
        .statusCode,
    ).toBe(404);
  });

  it('reports a stale review and compares it again (#163)', async () => {
    const base = await importedTree();
    const { reimportId } = await startReimport(base);
    expect((await api.get(`/api/reimports/${reimportId}/status`)).json()).toEqual({ stale: false });
    const people = (await api.get(`${base}/people?limit=1`)).json();
    await api.patch(`${base}/people/${people.items[0].id}`, { sex: 'X' });
    expect((await api.get(`/api/reimports/${reimportId}/status`)).json()).toEqual({ stale: true });
    expect((await api.get(`/api/reimports/${reimportId}`)).json().stale).toBe(true);
    const again = await api.post(`/api/reimports/${reimportId}/refresh`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: reimportId, stale: false });
    expect(again.json().diff.people.length).toBeGreaterThan(0);
    expect((await api.post(`/api/reimports/${reimportId}/apply`, { accept: [] })).statusCode).toBe(
      200,
    );
    expect((await api.post(`/api/reimports/${reimportId}/refresh`)).statusCode).toBe(404);
  });

  it('can be discarded, and fails cleanly on a bad file', async () => {
    const base = await importedTree();
    const { reimportId } = await startReimport(base);
    expect((await api.del(`/api/reimports/${reimportId}`)).statusCode).toBe(204);
    expect((await api.get(`/api/reimports/${reimportId}`)).statusCode).toBe(404);
    const res = await api.inject({
      method: 'POST',
      url: `${base}/reimport`,
      ...multipart('x.ged', 'not gedcom\n'),
    });
    const job = await waitForJob(res.json().jobId);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/does not look like GEDCOM/);
    expect((await api.get(base)).json().tree.peopleCount).toBe(26);
  });
});
