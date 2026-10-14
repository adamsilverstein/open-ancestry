/// <reference lib="webworker" />
import {
  layoutDescendants,
  layoutFamily,
  layoutFan,
  layoutPedigree,
  type FanLayout,
  type TreeLayout,
} from '@open-ancestry/core';
import { GraphCache } from './graphCache';
import type { WorkerRequest, WorkerResponse } from './layoutClient';

/*
 * Runs the tree layout off the main thread. The worker keeps its own copy of
 * the merged neighborhood graph, so each slice is posted once and a layout
 * request carries only the focus and options.
 */

const cache = new GraphCache();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'merge') {
    cache.merge(message.slice);
    return;
  }
  const start = performance.now();
  const graph = cache.graph();
  const { kind, focusId, options } = message;
  let layout: TreeLayout | null = null;
  let fan: FanLayout | null = null;
  if (kind === 'fan') fan = layoutFan(graph, focusId, options);
  else if (kind === 'pedigree') layout = layoutPedigree(graph, focusId, options);
  else if (kind === 'descendants') layout = layoutDescendants(graph, focusId, options);
  else layout = layoutFamily(graph, focusId, options);
  const response: WorkerResponse = {
    id: message.id,
    layout,
    fan,
    ms: performance.now() - start,
  };
  self.postMessage(response);
};
