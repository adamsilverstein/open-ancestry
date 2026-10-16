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
import { buildRelations, kinshipLabels } from './relations';
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
  try {
    // Kept by the cache between layouts, so a small view costs what it shows,
    // not everything merged this session (#210).
    const graph = cache.index();
    const { kind, focusId, options } = message;
    let layout: TreeLayout | null = null;
    let fan: FanLayout | null = null;
    let kin: Record<string, string> = {};
    if (kind === 'fan') fan = layoutFan(graph, focusId, options);
    else if (kind === 'pedigree') layout = layoutPedigree(graph, focusId, options);
    else if (kind === 'descendants') layout = layoutDescendants(graph, focusId, options);
    else layout = layoutFamily(graph, focusId, options);
    if (layout?.focusKey) {
      // Card labels ("father of ..."): one walk here instead of one per card on the main thread.
      const nodes = new Map(layout.nodes.map((n) => [n.key, n.personId]));
      kin = kinshipLabels(
        buildRelations(layout, graph),
        layout.focusKey,
        (key) => graph.person(nodes.get(key)!)?.sex ?? 'U',
      );
    }
    const response: WorkerResponse = {
      id: message.id,
      layout,
      fan,
      kin,
      ms: performance.now() - start,
    };
    self.postMessage(response);
  } catch (error) {
    // Bad data must not leave the view waiting forever.
    const response: WorkerResponse = {
      id: message.id,
      layout: null,
      fan: null,
      kin: {},
      ms: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
