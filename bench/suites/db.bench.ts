import {
  bulkInsert,
  generateSyntheticTree,
  getNeighborhood,
  getPersonDetail,
  openMemoryTree,
  rebuildSearchIndexInChunks,
  searchPeople,
  type SyntheticTree,
  type TreeStore,
} from '../../packages/db/src/index';
import type { BenchCase } from '../types';

// Budgets for packages/db alone, tighter than the API budgets in design.md
// section 7 (20ms p95) so the server has room for serialization and HTTP.
let data: SyntheticTree;
let store: TreeStore;
let ids: string[];
let i = 0;
const nextId = () => ids[i++ % ids.length] as string;

function loaded() {
  data ??= generateSyntheticTree({ people: 10_000, seed: 1 });
  if (!store) {
    store = openMemoryTree();
    bulkInsert(store, data);
    // People with parents, so the neighborhood has ancestors to walk.
    ids = data.family_child.map((c) => c.child_id);
  }
}

let big: TreeStore | undefined;

function loadedBig() {
  if (big) return;
  big = openMemoryTree();
  bulkInsert(big, generateSyntheticTree({ people: 100_000, seed: 2 }));
}

export default [
  {
    name: 'db: bulk insert 10k-person tree',
    setup: () => {
      data ??= generateSyntheticTree({ people: 10_000, seed: 1 });
    },
    fn: () => {
      const s = openMemoryTree();
      bulkInsert(s, data);
      s.close();
    },
    // About 400ms on an M-series laptop; shared CI runners have measured 700-950ms.
    // Spec budget for the whole 10k import (parse + map + load) is 3s.
    budgetMs: 1500,
    metric: 'mean',
    iterations: 5,
    time: 0,
  },
  {
    name: 'db: neighborhood up 4 down 3 (10k tree)',
    setup: loaded,
    fn: () => getNeighborhood(store, nextId(), { up: 4, down: 3 }),
    budgetMs: 5,
  },
  {
    name: 'db: person detail (10k tree)',
    setup: loaded,
    fn: () => getPersonDetail(store, nextId()),
    budgetMs: 5,
  },
  {
    name: 'db: search by name (10k tree)',
    setup: loaded,
    fn: () => searchPeople(store, ['ash', 'bel', 'cor', 'dun', 'ell'][i++ % 5] as string),
    budgetMs: 50,
  },
  {
    // A broad prefix: "19" matches nearly every birth year, so most of the tree (#305).
    name: 'db: search, year prefix "19", palette page (100k tree)',
    setup: loadedBig,
    fn: () => searchPeople(big!, '19', { limit: 8 }),
    budgetMs: 50,
  },
  {
    // Broader still: "we" starts names and places for 44k of the 100k people.
    name: 'db: search, prefix "we", palette page (100k tree)',
    setup: loadedBig,
    fn: () => searchPeople(big!, 'we', { limit: 8 }),
    budgetMs: 50,
  },
  {
    name: 'db: search by name, palette page (100k tree)',
    setup: loadedBig,
    fn: () =>
      searchPeople(big!, ['ash', 'bel', 'cor', 'dun', 'ell'][i++ % 5] as string, { limit: 8 }),
    budgetMs: 50,
  },
  {
    // The server rebuilds a stale search index (#199) one chunk per event-loop
    // turn; this is the longest a request can wait behind one chunk.
    name: 'db: search index rebuild, one 2000-person chunk (100k tree)',
    setup: loadedBig,
    fn: () => {
      const chunks = rebuildSearchIndexInChunks(big!, 2000);
      chunks.next();
      void chunks.return(undefined);
    },
    budgetMs: 100,
    metric: 'p99',
    iterations: 20,
  },
  {
    name: 'db: full search index rebuild in chunks (100k tree)',
    setup: loadedBig,
    fn: () => {
      for (const done of rebuildSearchIndexInChunks(big!, 2000)) void done;
    },
    budgetMs: 5000,
    metric: 'mean',
    iterations: 2,
    time: 0,
    warmupIterations: 0,
  },
] satisfies BenchCase[];
