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
  /** Time spent in the worker. */
  ms: number;
}

/**
 * Promise wrapper around the layout worker. The worker starts on first use;
 * after `dispose` (e.g. a StrictMode remount) the next call starts a new one
 * and replays the slices merged so far and any unanswered requests.
 */
export class LayoutClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (response: WorkerResponse) => void; message: WorkerRequest }
  >();
  private readonly slices: ApiNeighborhood[] = [];

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), {
      type: 'module',
      name: 'tree-layout',
    });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      this.pending.delete(event.data.id);
      request?.resolve(event.data);
    };
    for (const slice of this.slices) worker.postMessage({ type: 'merge', slice });
    for (const { message } of this.pending.values()) worker.postMessage(message);
    this.worker = worker;
    return worker;
  }

  private post(message: WorkerRequest) {
    this.start().postMessage(message);
  }

  merge(slice: ApiNeighborhood) {
    this.slices.push(slice);
    if (this.worker) this.post({ type: 'merge', slice });
  }

  layout(request: LayoutRequest): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const message: WorkerRequest = { type: 'layout', id, ...request };
      this.pending.set(id, { resolve, message });
      this.post(message);
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }
}
