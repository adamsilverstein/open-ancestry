import { describe, expect, it, vi } from 'vitest';
import { JobManager, TooManyJobsError } from './jobs';

const meta = { tree: 't', fileName: 'f.ged' };

describe('JobManager', () => {
  it('runs jobs one at a time in order and keeps a bounded history', async () => {
    const jobs = new JobManager({ concurrency: 1, maxQueued: 10, keepFinished: 2 });
    const order: number[] = [];
    const views = [1, 2, 3].map((n) =>
      jobs.enqueue(meta, async () => {
        order.push(n);
        await new Promise((r) => setTimeout(r, 5));
        return n;
      }),
    );
    expect(views.map((v) => v.state)).toEqual(['running', 'queued', 'queued']);
    await vi.waitFor(() => expect(jobs.get(views[2]!.id)?.state).toBe('completed'));
    expect(order).toEqual([1, 2, 3]);
    // The oldest finished job was pruned.
    expect(jobs.get(views[0]!.id)).toBeUndefined();
    expect(jobs.get(views[2]!.id)?.result).toBe(3);
  });

  it('refuses work past the queue limit', () => {
    const jobs = new JobManager({ concurrency: 1, maxQueued: 1 });
    const never = () => new Promise(() => {});
    jobs.enqueue(meta, never);
    jobs.enqueue(meta, never);
    expect(() => jobs.enqueue(meta, never)).toThrow(TooManyJobsError);
  });

  it('cancels queued jobs on shutdown and always cleans up', async () => {
    const jobs = new JobManager({ concurrency: 1 });
    const cleaned: string[] = [];
    const running = jobs.enqueue(
      meta,
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('stop'))),
        ),
      async () => void cleaned.push('a'),
    );
    const queued = jobs.enqueue(
      meta,
      async () => 'never',
      async () => void cleaned.push('b'),
    );
    await jobs.shutdown();
    expect(jobs.get(running.id)).toMatchObject({ state: 'failed', error: 'stop' });
    expect(jobs.get(queued.id)).toMatchObject({ state: 'failed', error: 'Cancelled' });
    expect(cleaned.sort()).toEqual(['a', 'b']);
  });

  it('reports non-Error failures and tolerates failing cleanup', async () => {
    const jobs = new JobManager();
    const job = jobs.enqueue(
      meta,
      async () => {
        throw 'boom';
      },
      async () => {
        throw new Error('cleanup failed');
      },
    );
    await vi.waitFor(() =>
      expect(jobs.get(job.id)).toMatchObject({ state: 'failed', error: 'boom' }),
    );
  });

  it('cancels a running job through its abort signal', async () => {
    const jobs = new JobManager();
    const cleaned: string[] = [];
    const job = jobs.enqueue(
      meta,
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Import was cancelled'))),
        ),
      async () => void cleaned.push('a'),
    );
    await vi.waitFor(() => expect(jobs.get(job.id)?.state).toBe('running'));
    expect(jobs.cancel(job.id)).toBe(true);
    await vi.waitFor(() =>
      expect(jobs.get(job.id)).toMatchObject({ state: 'failed', error: 'Import was cancelled' }),
    );
    expect(cleaned).toEqual(['a']);
    // Finished jobs cannot be cancelled; unknown ones neither.
    expect(jobs.cancel(job.id)).toBe(false);
    expect(jobs.cancel('nope')).toBe(false);
  });

  it('cancels a queued job at once, without running it', async () => {
    const jobs = new JobManager({ concurrency: 1 });
    let release!: () => void;
    const first = jobs.enqueue(meta, () => new Promise<void>((r) => (release = r)));
    let ran = false;
    const cleaned: string[] = [];
    const queued = jobs.enqueue(
      meta,
      async () => void (ran = true),
      async () => void cleaned.push('q'),
    );
    expect(jobs.cancel(queued.id)).toBe(true);
    await vi.waitFor(() =>
      expect(jobs.get(queued.id)).toMatchObject({ state: 'failed', error: 'Cancelled' }),
    );
    expect(cleaned).toEqual(['q']);
    release();
    await vi.waitFor(() => expect(jobs.get(first.id)?.state).toBe('completed'));
    expect(ran).toBe(false);
  });
});
