import { fileURLToPath } from 'node:url';
import { Worker, type ResourceLimits } from 'node:worker_threads';
import type { Importer } from './jobs';
import type { WorkerInput, WorkerMessage } from './import-worker';

/*
 * Runs each import in a worker thread with its own heap limit. A hostile or
 * huge file can exhaust only the worker (the job fails, the server keeps
 * serving), nothing blocks the event loop, and cancel works mid-parse: the
 * worker gets a cooperative cancel, then is terminated after `graceMs`.
 */

export const IMPORT_RESOURCE_LIMITS: ResourceLimits = {
  // A 64 MiB file (the import cap) of a real 100k-person export needs ~1 GiB.
  maxOldGenerationSizeMb: 2048,
};

export interface WorkerImporterOptions {
  resourceLimits?: ResourceLimits;
  /** Wait this long for a cooperative cancel before terminating (default 2000ms). */
  graceMs?: number;
}

export function workerImporter(
  script: URL | string,
  {
    resourceLimits = IMPORT_RESOURCE_LIMITS,
    graceMs = 2000,
    execArgv,
  }: WorkerImporterOptions & {
    execArgv?: string[];
  } = {},
): Importer {
  return (path, store, { onProgress, signal }) =>
    new Promise((resolve, reject) => {
      if (!store.dir) return reject(new Error('Imports need a tree on disk'));
      const workerData: WorkerInput = { path, treeDir: store.dir };
      const worker = new Worker(script, {
        workerData,
        resourceLimits,
        ...(execArgv && { execArgv }),
      });
      let outcome: { ok: true; value: unknown } | { ok: false; error: Error } | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        outcome ??= { ok: false, error: new Error('Import was cancelled') };
        worker.postMessage('cancel');
        killTimer = setTimeout(() => void worker.terminate(), graceMs);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });

      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'progress') onProgress(message.progress);
        else if (message.type === 'done') outcome ??= { ok: true, value: message.report };
        else outcome ??= { ok: false, error: new Error(message.message) };
      });
      worker.on('error', (error: Error & { code?: string }) => {
        outcome ??= {
          ok: false,
          error:
            error.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? new Error('The import ran out of memory; the file is too large or malformed')
              : error,
        };
      });
      // Settle only once the worker is gone, so cleanup never races its writes.
      worker.on('exit', (code) => {
        clearTimeout(killTimer);
        signal.removeEventListener('abort', onAbort);
        const result = outcome ?? {
          ok: false as const,
          error: new Error(`The import stopped unexpectedly (exit ${code})`),
        };
        if (result.ok) resolve(result.value);
        else reject(result.error);
      });
    });
}

/** The worker from TypeScript source, for `npm run dev` and tests (needs tsx). */
export function devWorkerImporter(options: WorkerImporterOptions = {}): Importer {
  return workerImporter(fileURLToPath(new URL('./import-worker.ts', import.meta.url)), {
    ...options,
    execArgv: ['--import', 'tsx'],
  });
}
