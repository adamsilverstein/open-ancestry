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
  answer(id: number) {
    this.onmessage?.({
      data: { id, layout: null, fan: null, kin: {}, ms: 1 },
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
});
