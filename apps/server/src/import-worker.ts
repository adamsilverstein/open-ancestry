import { parentPort, workerData } from 'node:worker_threads';
import { openTree } from '@open-ancestry/db';
import { importGedcom, ImportError, type ImportLimits } from '@open-ancestry/import';

/*
 * Worker thread entry for one import (see import-runner.ts). It opens its own
 * connection to the tree, so the server's event loop never runs parse, map or
 * commit, and the server can terminate it outright.
 */

export interface WorkerInput {
  path: string;
  treeDir: string;
  limits: Partial<ImportLimits>;
}

export type WorkerMessage =
  | { type: 'progress'; progress: { phase: string; done: number; total: number } }
  | { type: 'done'; report: unknown }
  | { type: 'error'; code: string | null; message: string };

const port = parentPort!;
const { path, treeDir, limits } = workerData as WorkerInput;
const controller = new AbortController();
port.on('message', (message) => {
  if (message === 'cancel') controller.abort();
});

const post = (message: WorkerMessage) => port.postMessage(message);
const store = openTree(treeDir);
try {
  const report = await importGedcom({ path }, store, {
    signal: controller.signal,
    limits,
    onProgress: (phase, done, total) =>
      post({ type: 'progress', progress: { phase, done, total } }),
  });
  post({ type: 'done', report });
} catch (error) {
  post({
    type: 'error',
    code: error instanceof ImportError ? error.code : null,
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  store.close();
  port.close();
}
