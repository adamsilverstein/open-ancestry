import type {
  ExpandKey,
  FanLayout,
  FanOptions,
  LayoutOptions,
  TreeLayout,
} from '@open-ancestry/core';
import type { TreeLayout as TreeLayoutKind } from '../components/TreeToolbar/TreeToolbar';
import type { ApiNeighborhood } from './api';

export interface LayoutRequest {
  kind: TreeLayoutKind;
  focusId: string;
  options: LayoutOptions & FanOptions & { expanded?: ExpandKey[]; collapsed?: ExpandKey[] };
}

export type WorkerRequest =
  { type: 'merge'; slice: ApiNeighborhood } | ({ type: 'layout'; id: number } & LayoutRequest);

export interface WorkerResponse {
  id: number;
  layout: TreeLayout | null;
  fan: FanLayout | null;
  /** Kinship of each card to the focus card, by layout key. */
  kin: Record<string, string>;
  /** Time spent in the worker. */
  ms: number;
  /** The layout threw; the message is for logs. */
  error?: string;
}

interface Pending {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  message: WorkerRequest;
}

/**
 * Promise wrapper around the layout worker. The worker starts on first use.
 * After `dispose` (a StrictMode remount) or a crash, the next call starts a
 * new one seeded with `snapshot()`, the merged graph so far, and re-sends any
 * unanswered requests.
 */
/**
 * The worker's time for each layout, as an `oa-tree-layout` measure, so tests
 * (and the browser's performance panel) can see it; at most 100 are kept, like
 * the re-focus measures.
 */
function recordLayoutTime(ms: number) {
  if (performance.getEntriesByName('oa-tree-layout', 'measure').length >= 100) {
    performance.clearMeasures('oa-tree-layout');
  }
  const end = performance.now();
  performance.measure('oa-tree-layout', { start: Math.max(0, end - ms), end });
}

export class LayoutClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Requests posted to the worker and not answered yet. */
  private readonly posted = new Set<number>();
  /** The newest speculative request, held until the worker is idle. */
  private queued: number | null = null;
  private snapshot: () => ApiNeighborhood;

  constructor(snapshot: () => ApiNeighborhood) {
    this.snapshot = snapshot;
  }

  /** Where the next worker's starting graph comes from. */
  setSnapshot(snapshot: () => ApiNeighborhood) {
    this.snapshot = snapshot;
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), {
      type: 'module',
      name: 'tree-layout',
    });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      this.pending.delete(event.data.id);
      this.posted.delete(event.data.id);
      this.drain();
      recordLayoutTime(event.data.ms);
      if (!request) return;
      if (event.data.error) request.reject(new Error(`Layout failed: ${event.data.error}`));
      else request.resolve(event.data);
    };
    const fail = (reason: string) => {
      // The worker is unusable: fail what is waiting, start fresh next time.
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      for (const request of this.pending.values()) request.reject(new Error(reason));
      this.pending.clear();
      this.posted.clear();
      this.queued = null;
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(`Layout worker error: ${event.message}`);
    };
    worker.onmessageerror = () => fail('Layout worker could not read a message');
    worker.postMessage({ type: 'merge', slice: this.snapshot() } satisfies WorkerRequest);
    this.worker = worker;
    for (const [id, { message }] of this.pending) {
      if (id === this.queued) continue;
      this.posted.add(id);
      worker.postMessage(message);
    }
    this.drain();
    return worker;
  }

  /** Posts the waiting speculative request once nothing else is in the worker. */
  private drain() {
    const id = this.queued;
    if (id === null || this.posted.size > 0 || !this.worker) return;
    const request = this.pending.get(id);
    this.queued = null;
    if (!request) return;
    this.posted.add(id);
    this.worker.postMessage(request.message);
  }

  /** Sends a new slice to a running worker; a new worker gets it in its snapshot. */
  merge(slice: ApiNeighborhood) {
    this.worker?.postMessage({ type: 'merge', slice } satisfies WorkerRequest);
  }

  /**
   * Lays out in the worker. A `speculative` request (a guess at the next
   * focus) never delays a real one: it waits until the worker is idle, and a
   * newer guess replaces it (the older one rejects). Returns the request id
   * for `prioritize`.
   */
  layout(
    request: LayoutRequest,
    { speculative = false } = {},
  ): Promise<WorkerResponse> & { id: number } {
    const id = this.nextId++;
    const promise = new Promise<WorkerResponse>((resolve, reject) => {
      const message: WorkerRequest = { type: 'layout', id, ...request };
      this.pending.set(id, { resolve, reject, message });
    });
    if (speculative) {
      const superseded = this.queued !== null ? this.pending.get(this.queued) : undefined;
      if (superseded && this.queued !== null) {
        this.pending.delete(this.queued);
        superseded.reject(new Error('Superseded by a newer guess'));
      }
      this.queued = id;
      if (this.worker) this.drain();
      else this.start();
    } else {
      this.post(id);
    }
    return Object.assign(promise, { id });
  }

  /** Sends a waiting speculative request now: it turned out to be the real one. */
  prioritize(id: number) {
    if (this.queued !== id) return;
    this.queued = null;
    this.post(id);
  }

  private post(id: number) {
    const running = this.worker;
    // A new worker sends everything pending, this request included.
    if (!running) {
      this.start();
      return;
    }
    const request = this.pending.get(id);
    if (!request) return;
    this.posted.add(id);
    running.postMessage(request.message);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    // Posted requests are re-sent by the next worker.
    this.posted.clear();
  }
}
