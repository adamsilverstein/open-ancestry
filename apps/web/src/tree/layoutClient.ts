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
export class LayoutClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly snapshot: () => ApiNeighborhood;

  constructor(snapshot: () => ApiNeighborhood) {
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
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(`Layout worker error: ${event.message}`);
    };
    worker.onmessageerror = () => fail('Layout worker could not read a message');
    worker.postMessage({ type: 'merge', slice: this.snapshot() } satisfies WorkerRequest);
    for (const { message } of this.pending.values()) worker.postMessage(message);
    this.worker = worker;
    return worker;
  }

  /** Sends a new slice to a running worker; a new worker gets it in its snapshot. */
  merge(slice: ApiNeighborhood) {
    this.worker?.postMessage({ type: 'merge', slice } satisfies WorkerRequest);
  }

  layout(request: LayoutRequest): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const message: WorkerRequest = { type: 'layout', id, ...request };
      const running = this.worker;
      this.pending.set(id, { resolve, reject, message });
      // A new worker re-sends everything pending, this request included.
      if (running) running.postMessage(message);
      else this.start();
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }
}
