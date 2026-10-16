import type { ReimportSession } from '@open-ancestry/import';
import type { ReimportFolders } from './reimport-folders';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { TreeStore } from '@open-ancestry/db';

/*
 * Background import jobs. Imports are CPU and disk heavy, so at most
 * `concurrency` run at once and at most `maxQueued` wait; past that, new
 * uploads are refused instead of piling up.
 */

export interface ImportProgress {
  [key: string]: unknown;
}

export interface ImporterOptions {
  onProgress: (progress: ImportProgress) => void;
  signal: AbortSignal;
}

/**
 * Imports a GEDCOM or GEDZIP file at `filePath` into the empty tree `target`.
 * The real one runs @open-ancestry/import in a worker thread
 * (`workerImporter` in import-runner.ts); it is injected so tests can fake it.
 * A GEDZIP brings its own media; an upload never reads media from local
 * folders.
 */
export type Importer = (
  filePath: string,
  target: TreeStore,
  options: ImporterOptions,
) => Promise<unknown>;

/**
 * Reads an updated export at `filePath` and compares it with `tree`, giving
 * back the review. The real one runs in a worker thread (`workerComparer`),
 * so a large compare never blocks the server (#161).
 */
export type Comparer = (
  filePath: string,
  tree: TreeStore,
  options: ImporterOptions & {
    /** Makes the review's working folders, owned by this server (see reimport-folders.ts). */
    folders: ReimportFolders;
  },
) => Promise<ReimportSession>;

export type JobState = 'queued' | 'running' | 'completed' | 'failed';

export interface JobView {
  id: string;
  kind: 'import' | 'reimport';
  tree: string;
  fileName: string;
  /** The server created `tree` for this upload (and removes it if the import fails). */
  createdTree: boolean;
  state: JobState;
  progress: ImportProgress | null;
  /** The importer's report once completed. */
  result: unknown;
  error: string | null;
  /** Stopped by a cancel (DELETE /api/jobs/:id or server shutdown), not by an error. */
  cancelled: boolean;
  createdAt: string;
  finishedAt: string | null;
}

export type JobEvent =
  { type: 'state'; job: JobView } | { type: 'progress'; progress: ImportProgress };

interface Job extends JobView {
  run: (signal: AbortSignal) => Promise<unknown>;
  controller: AbortController;
  /** A queued job being cancelled: cleaning up, never to run. */
  cancelling?: boolean;
  /** Its work returned or threw: only cleanup is left, which a cancel can't stop. */
  finished?: boolean;
  cleanup: () => Promise<void>;
}

export interface JobManagerOptions {
  concurrency?: number;
  maxQueued?: number;
  /** Finished jobs kept for status queries. */
  keepFinished?: number;
}

/** Progress phases a cancel can no longer interrupt (importers run them to the end). */
export const UNCANCELLABLE_PHASES: ReadonlySet<string> = new Set(['finalize', 'commit', 'done']);

export class TooManyJobsError extends Error {
  constructor() {
    super('Too many imports are queued; try again when one finishes');
    this.name = 'TooManyJobsError';
  }
}

/** The server is shutting down and takes no new jobs. */
export class ShuttingDownError extends Error {
  constructor() {
    super('The server is shutting down; try again once it has restarted');
    this.name = 'ShuttingDownError';
  }
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly events = new EventEmitter();
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly keepFinished: number;
  private running = 0;
  private draining = false;

  constructor({ concurrency = 1, maxQueued = 4, keepFinished = 50 }: JobManagerOptions = {}) {
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
    this.keepFinished = keepFinished;
    this.events.setMaxListeners(0);
  }

  /** Whether a new job could be queued now (checked before accepting an upload). */
  hasRoom(): boolean {
    if (this.draining) throw new ShuttingDownError();
    const queued = [...this.jobs.values()].filter((j) => j.state === 'queued').length;
    return queued < this.maxQueued;
  }

  get(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    return job ? view(job) : undefined;
  }

  /**
   * Queues work. `run` receives an abort signal and may report progress through
   * the returned job's `progress`; `cleanup` always runs once the job ends.
   */
  enqueue(
    meta: { tree: string; fileName: string; createdTree?: boolean; kind?: JobView['kind'] },
    run: (signal: AbortSignal, progress: (p: ImportProgress) => void) => Promise<unknown>,
    cleanup: () => Promise<void> = async () => {},
  ): JobView {
    if (this.draining) throw new ShuttingDownError();
    const queued = [...this.jobs.values()].filter((j) => j.state === 'queued').length;
    if (queued >= this.maxQueued) throw new TooManyJobsError();
    const id = randomUUID();
    const job: Job = {
      id,
      tree: meta.tree,
      fileName: meta.fileName,
      kind: meta.kind ?? 'import',
      createdTree: meta.createdTree ?? false,
      state: 'queued',
      progress: null,
      result: null,
      error: null,
      cancelled: false,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      controller: new AbortController(),
      run: (signal) => run(signal, (p) => this.progress(job, p)),
      cleanup,
    };
    this.jobs.set(id, job);
    this.pump();
    return view(job);
  }

  /** Subscribes to a job's events; returns an unsubscribe function. */
  subscribe(id: string, listener: (event: JobEvent) => void): () => void {
    this.events.on(id, listener);
    return () => this.events.off(id, listener);
  }

  /**
   * Cancels a queued or running job: a queued one fails at once (after its
   * cleanup), a running one is aborted through its signal and fails when the
   * work stops. Returns false for unknown or finished jobs.
   */
  /**
   * Whether `cancel` can still stop the job: it is queued, or running in a
   * phase the work checks its abort signal in. An importer reports `finalize`
   * and `commit` for the stretch it runs to the end without checking; a
   * re-import's compare can always be stopped, since those phases are of its
   * scratch copy. Once the work has returned, nothing is left to stop.
   */
  cancellable(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === 'queued') return true;
    if (job.state !== 'running' || job.finished) return false;
    // A re-import's compare never writes the tree: its importer phases are of a scratch copy.
    if (job.kind === 'reimport') return true;
    const phase = job.progress?.phase;
    return !(typeof phase === 'string' && UNCANCELLABLE_PHASES.has(phase));
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || !this.cancellable(id)) return false;
    job.controller.abort();
    if (job.state === 'queued' && !job.cancelling) {
      job.cancelled = true;
      // Never picked up by pump(): it skips jobs that are cancelling.
      job.cancelling = true;
      job.error = 'Cancelled';
      void job
        .cleanup()
        .catch(() => {})
        .then(() => this.setState(job, 'failed'));
    }
    return true;
  }

  /** Cancels every active job and waits for them to settle (server shutdown). */
  async shutdown(): Promise<void> {
    // From now on new work is refused (503), so the wait below can only shrink.
    this.draining = true;
    const active = [...this.jobs.values()].filter(
      (j) => j.state === 'queued' || j.state === 'running',
    );
    for (const job of active) this.cancel(job.id);
    await Promise.all(active.map((job) => this.settled(job.id)));
  }

  private settled(id: string): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const job = this.jobs.get(id);
        if (!job || job.state === 'completed' || job.state === 'failed') {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = this.subscribe(id, check);
      check();
    });
  }

  private progress(job: Job, progress: ImportProgress): void {
    job.progress = progress;
    this.events.emit(job.id, { type: 'progress', progress } satisfies JobEvent);
  }

  private setState(job: Job, state: JobState): void {
    job.state = state;
    if (state === 'completed' || state === 'failed') job.finishedAt = new Date().toISOString();
    this.events.emit(job.id, { type: 'state', job: view(job) } satisfies JobEvent);
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const next = [...this.jobs.values()].find((j) => j.state === 'queued' && !j.cancelling);
      if (!next) return;
      this.running++;
      void this.execute(next).finally(() => {
        this.running--;
        this.prune();
        this.pump();
      });
    }
  }

  private async execute(job: Job): Promise<void> {
    let state: JobState = 'completed';
    if (job.controller.signal.aborted) {
      job.error = 'Cancelled';
      job.cancelled = true;
      state = 'failed';
    } else {
      this.setState(job, 'running');
      try {
        job.result = (await job.run(job.controller.signal)) ?? null;
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error);
        state = 'failed';
        // Only a failure after an abort is a cancel; work that finished anyway completed.
        job.cancelled = job.controller.signal.aborted;
      }
      job.finished = true;
    }
    // Clean up first, so a finished job never leaves its upload behind.
    await job.cleanup().catch(() => {});
    this.setState(job, state);
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter(
      (j) => j.state === 'completed' || j.state === 'failed',
    );
    for (const job of finished.slice(0, Math.max(0, finished.length - this.keepFinished)))
      this.jobs.delete(job.id);
  }
}

function view(job: Job): JobView {
  return {
    id: job.id,
    kind: job.kind,
    tree: job.tree,
    fileName: job.fileName,
    createdTree: job.createdTree,
    state: job.state,
    progress: job.progress,
    result: job.result,
    error: job.error,
    cancelled: job.cancelled,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}
