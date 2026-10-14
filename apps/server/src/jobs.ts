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
  /** The tree's media/ folder, for files extracted from a GEDZIP. */
  mediaDir: string;
  onProgress: (progress: ImportProgress) => void;
  signal: AbortSignal;
}

/**
 * Imports a GEDCOM or GEDZIP file at `filePath` into the empty tree `target`.
 * Wire the real importer with
 * `(path, store, options) => importGedcom({ path }, store, options)` from
 * @open-ancestry/import; it is injected so tests can fake it.
 */
export type Importer = (
  filePath: string,
  target: TreeStore,
  options: ImporterOptions,
) => Promise<unknown>;

export type JobState = 'queued' | 'running' | 'completed' | 'failed';

export interface JobView {
  id: string;
  kind: 'import';
  tree: string;
  fileName: string;
  /** The server created `tree` for this upload (and removes it if the import fails). */
  createdTree: boolean;
  state: JobState;
  progress: ImportProgress | null;
  /** The importer's report once completed. */
  result: unknown;
  error: string | null;
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
  cleanup: () => Promise<void>;
}

export interface JobManagerOptions {
  concurrency?: number;
  maxQueued?: number;
  /** Finished jobs kept for status queries. */
  keepFinished?: number;
}

export class TooManyJobsError extends Error {
  constructor() {
    super('Too many imports are queued; try again when one finishes');
    this.name = 'TooManyJobsError';
  }
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly events = new EventEmitter();
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly keepFinished: number;
  private running = 0;

  constructor({ concurrency = 1, maxQueued = 4, keepFinished = 50 }: JobManagerOptions = {}) {
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
    this.keepFinished = keepFinished;
    this.events.setMaxListeners(0);
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
    meta: { tree: string; fileName: string; createdTree?: boolean },
    run: (signal: AbortSignal, progress: (p: ImportProgress) => void) => Promise<unknown>,
    cleanup: () => Promise<void> = async () => {},
  ): JobView {
    const queued = [...this.jobs.values()].filter((j) => j.state === 'queued').length;
    if (queued >= this.maxQueued) throw new TooManyJobsError();
    const id = randomUUID();
    const job: Job = {
      id,
      kind: 'import',
      createdTree: false,
      ...meta,
      state: 'queued',
      progress: null,
      result: null,
      error: null,
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
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || (job.state !== 'queued' && job.state !== 'running')) return false;
    job.controller.abort();
    if (job.state === 'queued' && !job.cancelling) {
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
      state = 'failed';
    } else {
      this.setState(job, 'running');
      try {
        job.result = (await job.run(job.controller.signal)) ?? null;
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error);
        state = 'failed';
      }
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
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}
