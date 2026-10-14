import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTree, type TreeStore } from '@open-ancestry/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateGedcom } from '../../../fixtures/generate';
import { devWorkerImporter, type WorkerImporterOptions } from './import-runner';
import type { ImportProgress } from './jobs';

/*
 * Imports run in a worker thread (security review): a hostile file can only
 * exhaust the worker's own memory, and cancel terminates it even mid-parse.
 */

let root: string;
let store: TreeStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-runner-'));
  store = createTree(join(root, 'T.oatree'));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function file(name: string, content: string) {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
}

function run(
  path: string,
  signal = new AbortController().signal,
  options: WorkerImporterOptions = {},
) {
  const progress: ImportProgress[] = [];
  const importer = devWorkerImporter(options);
  return {
    progress,
    done: importer(path, store, { onProgress: (p) => progress.push(p), signal }),
  };
}

describe('worker importer', () => {
  it('imports in a worker; the server-side store sees the result', async () => {
    const { done, progress } = run(file('a.ged', generateGedcom({ people: 200, seed: 2 })));
    const report = (await done) as { records: { INDI: number } };
    expect(report.records.INDI).toBe(200);
    expect(progress.map((p) => p.phase)).toEqual(
      expect.arrayContaining(['read', 'parse', 'map', 'done']),
    );
    const { n } = store.db.prepare('SELECT count(*) AS n FROM person').get() as { n: number };
    expect(n).toBe(200);
  }, 60_000);

  it('passes import refusals through with their message', async () => {
    const { done } = run(file('bad.ged', 'hello, not a gedcom\n'));
    await expect(done).rejects.toThrow(/does not look like GEDCOM/);
  }, 30_000);

  it('applies the import limits it was given inside the worker', async () => {
    const text = ['0 HEAD', '0 @I1@ INDI', '1 NOTE a', '2 CONT b', '2 CONT c', '0 TRLR', ''].join(
      '\n',
    );
    const { done } = run(file('conts.ged', text), undefined, {
      limits: { maxContinuations: 1 },
    });
    await expect(done).rejects.toThrow(/continuation lines/);
  }, 30_000);

  it('cancels promptly, even mid-parse, and leaves the tree writable', async () => {
    const controller = new AbortController();
    const { done, progress } = run(
      file('big.ged', generateGedcom({ people: 60_000, seed: 3 })),
      controller.signal,
      { graceMs: 200 },
    );
    while (!progress.some((p) => p.phase === 'parse')) await new Promise((r) => setTimeout(r, 5));
    const started = performance.now();
    controller.abort();
    await expect(done).rejects.toThrow(/cancelled/i);
    expect(performance.now() - started).toBeLessThan(3000);
    // No lock left behind by the worker's connection.
    store.transact('after', (tx) => tx.insert('person', {}));
    const { n } = store.db.prepare('SELECT count(*) AS n FROM person').get() as { n: number };
    expect(n).toBe(1);
  }, 60_000);

  it('fails the job, not the server, when the worker runs out of memory', async () => {
    const { done } = run(file('huge.ged', generateGedcom({ people: 40_000, seed: 4 })), undefined, {
      resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4 },
    });
    await expect(done).rejects.toThrow(/memory/i);
    expect(process.memoryUsage().rss).toBeGreaterThan(0);
  }, 60_000);

  it('lets a cancel that arrives while saving wait for the real outcome', async () => {
    const controller = new AbortController();
    const progress: ImportProgress[] = [];
    const importer = devWorkerImporter({ graceMs: 1 });
    const done = importer(file('ok.ged', generateGedcom({ people: 300, seed: 8 })), store, {
      onProgress: (p) => {
        progress.push(p);
        if (p.phase === 'finalize') controller.abort();
      },
      signal: controller.signal,
    });
    const report = (await done) as { records: { INDI: number } };
    expect(controller.signal.aborted).toBe(true);
    expect(report.records.INDI).toBe(300);
  }, 60_000);
});
