import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutClient, type WorkerRequest, type WorkerResponse } from './layoutClient';
import type { ApiNeighborhood } from './api';

/** Records what the client posts and answers layouts when told to. */
class FakeWorker {
  static last: FakeWorker;
  posted: WorkerRequest[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: WorkerRequest) {
    this.posted.push(message);
  }
  terminate() {}
  layouts() {
    return this.posted.filter((m) => m.type === 'layout') as Extract<
      WorkerRequest,
      { type: 'layout' }
    >[];
  }
  answer(id: number, ms = 1) {
    this.onmessage?.({
      data: { id, layout: null, fan: null, kin: {}, ms },
    } as MessageEvent<WorkerResponse>);
  }
}

const empty: ApiNeighborhood = {
  focusId: '',
  people: [],
  families: [],
  children: [],
  moreUp: [],
  moreDown: [],
  childrenLoaded: [],
  moreSiblings: [],
  siblingsLoaded: [],
  truncated: false,
};
const request = (focusId: string) => ({ kind: 'family' as const, focusId, options: {} });

describe('LayoutClient', () => {
  beforeEach(() => vi.stubGlobal('Worker', FakeWorker));
  afterEach(() => vi.unstubAllGlobals());

  it('holds a guess until the worker is idle, behind real layouts', async () => {
    const client = new LayoutClient(() => empty);
    const real = client.layout(request('a'));
    const worker = FakeWorker.last;
    const guess = client.layout(request('b'), { speculative: true });
    expect(worker.layouts().map((m) => m.focusId)).toEqual(['a']);
    worker.answer(real.id);
    await real;
    // Idle now: the guess goes out.
    expect(worker.layouts().map((m) => m.focusId)).toEqual(['a', 'b']);
    worker.answer(guess.id);
    await expect(guess).resolves.toMatchObject({ id: guess.id });
  });

  it('keeps one waiting guess: a newer one supersedes it', async () => {
    const client = new LayoutClient(() => empty);
    const real = client.layout(request('a'));
    const first = client.layout(request('b'), { speculative: true });
    const second = client.layout(request('c'), { speculative: true });
    await expect(first).rejects.toThrow('Superseded');
    FakeWorker.last.answer(real.id);
    expect(FakeWorker.last.layouts().map((m) => m.focusId)).toEqual(['a', 'c']);
    FakeWorker.last.answer(second.id);
    await second;
  });

  it('sends a waiting guess at once when it turns out to be the real request', () => {
    const client = new LayoutClient(() => empty);
    client.layout(request('a'));
    const guess = client.layout(request('b'), { speculative: true });
    client.prioritize(guess.id);
    expect(FakeWorker.last.layouts().map((m) => m.focusId)).toEqual(['a', 'b']);
    // Prioritizing again (or an unknown id) posts nothing more.
    client.prioritize(guess.id);
    client.prioritize(999);
    expect(FakeWorker.last.layouts()).toHaveLength(2);
  });

  it('starts the worker for a first guess and sends it straight away', () => {
    const client = new LayoutClient(() => empty);
    client.layout(request('b'), { speculative: true });
    expect(FakeWorker.last.posted[0]).toMatchObject({ type: 'merge' });
    expect(FakeWorker.last.layouts().map((m) => m.focusId)).toEqual(['b']);
  });

  it('records each worker layout time as an oa-tree-layout measure, at most 100', async () => {
    performance.clearMeasures('oa-tree-layout');
    const client = new LayoutClient(() => empty);
    const first = client.layout(request('a'));
    FakeWorker.last.answer(first.id, 12.5);
    await first;
    const [entry] = performance.getEntriesByName('oa-tree-layout', 'measure');
    expect(entry!.duration).toBeCloseTo(12.5, 1);
    for (let i = 0; i < 120; i++) {
      const next = client.layout(request(`p${i}`));
      FakeWorker.last.answer(next.id);
      await next;
    }
    expect(performance.getEntriesByName('oa-tree-layout', 'measure').length).toBeLessThanOrEqual(
      100,
    );
  });

  it('still settles a layout when the browser cannot record its time', async () => {
    const measure = vi.spyOn(performance, 'measure').mockImplementation(() => {
      throw new TypeError('no timeline');
    });
    try {
      const client = new LayoutClient(() => empty);
      const done = client.layout(request('a'));
      FakeWorker.last.answer(done.id);
      await expect(done).resolves.toMatchObject({ id: done.id });
    } finally {
      measure.mockRestore();
    }
  });
});
