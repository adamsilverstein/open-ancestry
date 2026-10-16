import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importFile, prepareReimport } from '@open-ancestry/import';
import { zipSync } from 'fflate';
import { devWorkerComparer } from './import-runner';
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

function multipart(fileName: string, content: string | Uint8Array) {
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
    const applied = await api.post(`/api/reimports/${reimportId}/apply`, { accept, comparison: 1 });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ applied: accept.length, blocked: [] });
    expect((await api.get(base)).json().tree.peopleCount).toBe(27);
    // The session is used up.
    expect((await api.get(`/api/reimports/${reimportId}`)).statusCode).toBe(404);
    const undo = await api.post(`${base}/undo`);
    expect(undo.json().batch.label).toBe('Re-import Family 2026.ged');
    expect((await api.get(base)).json().tree.peopleCount).toBe(26);
  });

  it("copies a GEDZIP export's new photo into the tree when applied (#75)", async () => {
    const base = await importedTree();
    const ged = laterSample().replace(
      '0 @I127@ INDI\n1 NAME Noah /Ashgrove/',
      '0 @I127@ INDI\n1 NAME Noah /Ashgrove/\n1 OBJE\n2 FILE photos/noah.jpg\n3 TITL Noah',
    );
    expect(ged).toContain('photos/noah.jpg');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const zip = zipSync({ 'tree.ged': new TextEncoder().encode(ged), 'photos/noah.jpg': jpeg });
    const res = await api.inject({
      method: 'POST',
      url: `${base}/reimport`,
      ...multipart('Family 2026.zip', zip),
    });
    const job = await waitForJob(res.json().jobId);
    const { reimportId } = job.result as { reimportId: string };
    const review = (await api.get(`/api/reimports/${reimportId}`)).json();
    expect(review.media).toMatchObject({ linked: 1, rejected: 0 });
    const accept = review.diff.people.flatMap(
      (p: { changes: { id: string; defaultAccept: boolean }[] }) =>
        p.changes.filter((c) => c.defaultAccept).map((c) => c.id),
    );
    const applied = (
      await api.post(`/api/reimports/${reimportId}/apply`, {
        accept,
        comparison: review.comparison,
      })
    ).json();
    expect(applied.media).toMatchObject({ refused: [] });
    expect(applied.media.copied).toHaveLength(1);
    const photo = await api.get(`${base}/media/${applied.media.copied[0]}`);
    expect(photo.statusCode).toBe(200);
    expect(photo.rawPayload).toEqual(jpeg);
  });

  it('refuses a stale review and validates the request', async () => {
    const base = await importedTree();
    const { reimportId } = await startReimport(base);
    expect(
      (
        await api.post(`/api/reimports/${reimportId}/apply`, {
          accept: [],
          comparison: 1,
          everything: true,
        })
      ).statusCode,
    ).toBe(400);
    const people = (await api.get(`${base}/people?limit=1`)).json();
    await api.patch(`${base}/people/${people.items[0].id}`, { sex: 'X' });
    const stale = await api.post(`/api/reimports/${reimportId}/apply`, {
      accept: [],
      comparison: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('conflict');
    expect(
      (
        await api.post(`/api/reimports/00000000-0000-4000-8000-000000000000/apply`, {
          accept: [],
          comparison: 1,
        })
      ).statusCode,
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
    expect(again.json()).toMatchObject({ id: reimportId, stale: false, comparison: 2 });
    expect(again.json().diff.people.length).toBeGreaterThan(0);
    expect(
      (await api.post(`/api/reimports/${reimportId}/apply`, { accept: [], comparison: 2 }))
        .statusCode,
    ).toBe(200);
    expect((await api.post(`/api/reimports/${reimportId}/refresh`)).statusCode).toBe(404);
  });

  it('refuses a review another client compared again (#184)', async () => {
    const base = await importedTree();
    const { reimportId } = await startReimport(base);
    // Both clients load comparison 1.
    const first = (await api.get(`/api/reimports/${reimportId}`)).json();
    expect(first.comparison).toBe(1);
    const people = (await api.get(`${base}/people?limit=1`)).json();
    await api.patch(`${base}/people/${people.items[0].id}`, { sex: 'X' });
    // Client B compares again; client A still holds comparison 1.
    expect((await api.post(`/api/reimports/${reimportId}/refresh`)).json().comparison).toBe(2);
    const status = (comparison: number) =>
      api.get(`/api/reimports/${reimportId}/status?comparison=${comparison}`);
    expect((await status(1)).json()).toEqual({ stale: true });
    expect((await status(2)).json()).toEqual({ stale: false });
    const late = await api.post(`/api/reimports/${reimportId}/apply`, {
      accept: first.diff.people.flatMap((p: { changes: { id: string }[] }) =>
        p.changes.map((c) => c.id),
      ),
      comparison: 1,
    });
    expect(late.statusCode).toBe(409);
    expect((await api.get(`${base}/history`)).json().items ?? []).toHaveLength(1);
  });

  it('keeps a review in use alive past its first hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const base = await importedTree();
      const { reimportId } = await startReimport(base);
      vi.setSystemTime(Date.now() + 50 * 60 * 1000);
      expect((await api.get(`/api/reimports/${reimportId}/status?comparison=1`)).statusCode).toBe(
        200,
      );
      vi.setSystemTime(Date.now() + 50 * 60 * 1000);
      expect((await api.get(`/api/reimports/${reimportId}`)).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
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

describe('re-import compare in a worker (#161)', () => {
  it('compares through the worker comparer and applies the review', async () => {
    await api.close();
    api = await testApi({ importer: importFile, comparer: devWorkerComparer() });
    const base = await importedTree();
    const { reimportId, counts } = await startReimport(base);
    expect(counts).toMatchObject({ matched: 26, newPeople: 1 });
    const review = (await api.get(`/api/reimports/${reimportId}`)).json();
    const accept = review.diff.people.flatMap(
      (p: { changes: { id: string; defaultAccept: boolean }[] }) =>
        p.changes.filter((c) => c.defaultAccept).map((c) => c.id),
    );
    const applied = await api.post(`/api/reimports/${reimportId}/apply`, {
      accept,
      comparison: review.comparison,
    });
    expect(applied.statusCode).toBe(200);
    expect((await api.get(base)).json().tree.peopleCount).toBe(27);
  }, 60_000);
});

describe('cancelling a re-import compare (#161)', () => {
  it('keeps no review when the compare finishes after a cancel was accepted', async () => {
    await api.close();
    let compared!: () => void;
    const finishedCompare = new Promise<void>((resolve) => (compared = resolve));
    api = await testApi({
      importer: importFile,
      // Like the worker: the compare runs to the end and ignores the abort.
      comparer: async (path, store, { signal }) => {
        const session = await prepareReimport(store, { path });
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        compared();
        return session;
      },
    });
    const base = await importedTree();
    const res = await api.inject({
      method: 'POST',
      url: `${base}/reimport`,
      ...multipart('Family 2026.ged', laterSample()),
    });
    const jobId = res.json().jobId as string;
    await vi.waitFor(async () => {
      expect((await api.get(`/api/jobs/${jobId}`)).json().state).toBe('running');
    });
    const cancel = await api.inject({
      method: 'DELETE',
      url: `/api/jobs/${jobId}`,
      headers: MUTATION_HEADERS,
    });
    expect(cancel.statusCode).toBeLessThan(300);
    await finishedCompare;
    const job = await waitForJob(jobId);
    // The cancel was accepted, so it wins: no review is left for anyone to apply.
    expect(job).toMatchObject({ state: 'failed', cancelled: true, result: null });
  });
});
