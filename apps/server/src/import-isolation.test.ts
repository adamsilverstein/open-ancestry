import { afterEach, describe, expect, it } from 'vitest';
import { generateGedcom } from '../../../fixtures/generate';
import { devWorkerImporter } from './import-runner';
import { MUTATION_HEADERS, createTestTree, testApi, type TestApi } from './test/helpers';

/*
 * Issue #186: on main the import's open transaction was on the server's
 * cached connection, so reads and exports during an import saw rows that
 * might still be rolled back. With the import in a worker on its own
 * connection, the server's reads see only committed data, and exporting a
 * tree mid-import is refused.
 */

let api: TestApi;
afterEach(() => api.close());

function upload(base: string, ged: string) {
  const boundary = '----oa-isolation';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.ged"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(ged),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return api.inject({
    method: 'POST',
    url: `${base}/import`,
    payload,
    headers: { ...MUTATION_HEADERS, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}

describe('reads while a tree imports in the worker', () => {
  it('see no uncommitted rows, and exports are refused until it ends', async () => {
    api = await testApi({ importer: devWorkerImporter() });
    const base = await createTestTree(api, 'Importing');
    const ged = generateGedcom({ people: 20_000, seed: 4 });
    const surname = /^1 NAME [^/\n]*\/([^/\n]+)\//m.exec(ged)![1]!;
    const started = await upload(base, ged);
    expect(started.statusCode, started.body).toBe(202);
    const { jobId } = started.json() as { jobId: string };

    // Poll until the job ends; during the import's transaction (map through
    // commit), nothing it has written may be visible.
    const seen = new Set<string>();
    for (;;) {
      const job = (await api.get(`/api/jobs/${jobId}`)).json() as {
        state: string;
        progress?: { phase: string };
      };
      if (job.state === 'completed' || job.state === 'failed') {
        expect(job.state).toBe('completed');
        break;
      }
      const [people, search, exported] = await Promise.all([
        api.get(`${base}/people?limit=5`),
        api.get(`${base}/search?q=${encodeURIComponent(surname)}`),
        api.get(`${base}/export.json`),
      ]);
      // Re-read the phase after the reads: the transaction may have committed meanwhile.
      const after = (await api.get(`/api/jobs/${jobId}`)).json() as { state: string };
      if (after.state === 'running') {
        seen.add(job.progress?.phase ?? 'queued');
        expect(people.json().total).toBe(0);
        expect(search.json().items).toEqual([]);
        expect(exported.statusCode).toBe(409);
        expect(exported.json().error.message).toMatch(/busy/);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect([...seen]).toContain('map');
    // Committed: now every read sees the whole import.
    expect((await api.get(`${base}/people?limit=1`)).json().total).toBe(20_000);
    expect((await api.get(`${base}/export.json`)).statusCode).toBe(200);
  }, 120_000);
});
