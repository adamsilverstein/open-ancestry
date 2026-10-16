import { parentPort, workerData } from 'node:worker_threads';
import { openTree } from '@open-ancestry/db';
import {
  importGedcom,
  ImportError,
  prepareReimport,
  reimportData,
  type ImportLimits,
} from '@open-ancestry/import';

/*
 * Worker thread entry for one import (see import-runner.ts). It opens its own
 * connection to the tree, so the server's event loop never runs parse, map or
 * commit, and the server can terminate it outright.
 */

export interface WorkerInput {
  path: string;
  treeDir: string;
  limits: Partial<ImportLimits>;
  /** A re-import compare (#161): import the export into `incomingDir`, compare, hand back. */
  reimport?: { incomingDir: string; mediaDir: string };
}

export type WorkerMessage =
  | { type: 'progress'; progress: { phase: string; done: number; total: number } }
  | { type: 'done'; report: unknown }
  | { type: 'error'; code: string | null; message: string };

const port = parentPort!;
const { path, treeDir, limits, reimport } = workerData as WorkerInput;
const controller = new AbortController();
port.on('message', (message) => {
  if (message === 'cancel') controller.abort();
});

const post = (message: WorkerMessage) => port.postMessage(message);
const store = openTree(treeDir);
const onProgress = (phase: string, done: number, total: number) =>
  post({ type: 'progress', progress: { phase, done, total } });
try {
  if (reimport) {
    // Reads the tree through this worker's own connection; writes only the export's tree.
    const session = await prepareReimport(
      store,
      { path },
      {
        signal: controller.signal,
        limits,
        onProgress,
        incomingDir: reimport.incomingDir,
        spillDir: () => reimport.mediaDir,
      },
    );
    session.incoming.close();
    post({ type: 'done', report: reimportData(session) });
  } else {
    const report = await importGedcom({ path }, store, {
      signal: controller.signal,
      limits,
      onProgress,
    });
    post({ type: 'done', report });
  }
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
