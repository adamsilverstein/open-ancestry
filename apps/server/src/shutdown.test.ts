import { join } from 'node:path';
import { meta, openTree } from '@open-ancestry/db';
import { describe, expect, it } from 'vitest';
import { startServer } from './index';
import type { Importer } from './jobs';
import { IMPORT_PENDING_KEY } from './library';
import { TOKEN } from './test/helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

/*
 * Review of #156: Ctrl-C while an import saved for more than 10s made close()
 * reject (Fastify's 10s pluginTimeout covers preClose hooks), the CLI exited
 * 1, and one run lost the import, leaving an empty tree with import_pending.
 */

const root = makeTempDir('oa-shutdown-');

describe('stopping the server while an import saves', () => {
  it('waits past 10s for the save, keeps the import, and closes cleanly', async () => {
    let saving!: () => void;
    const reachedCommit = new Promise<void>((r) => (saving = r));
    // Past the point of no return: the save runs to the end whatever the signal says.
    const importer: Importer = async (_path, store, { onProgress }) => {
      onProgress({ phase: 'commit', done: 0, total: 1 });
      saving();
      await new Promise((r) => setTimeout(r, 11_000));
      store.db
        .prepare("INSERT INTO person (id, created_at, updated_at) VALUES ('01SAVED', 'x', 'x')")
        .run();
      return { records: { INDI: 1 } };
    };
    const server = await startServer({ library: root, importer, token: TOKEN });
    const origin = server.url;
    const form = new FormData();
    form.append('file', new Blob(['0 HEAD\n0 TRLR\n']), 'Slow save.ged');
    const res = await fetch(`${server.url}/api/import`, {
      method: 'POST',
      headers: { origin, 'x-oa-token': TOKEN },
      body: form,
    });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: { tree: string } };
    await reachedCommit;

    const started = performance.now();
    await expect(server.close()).resolves.toBeUndefined();
    expect(performance.now() - started).toBeGreaterThan(10_000);

    // The import was kept: its person is there and the tree is the user's.
    const store = openTree(join(root, `${job.tree}.oatree`));
    try {
      expect(store.db.prepare('SELECT id FROM person').pluck().all()).toEqual(['01SAVED']);
      expect(meta.get(store, IMPORT_PENDING_KEY)).toBeFalsy();
    } finally {
      store.close();
    }
  }, 40_000);
});
