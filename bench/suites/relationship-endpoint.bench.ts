import {
  bulkInsert,
  generateSyntheticTree,
  getRelationship,
  openMemoryTree,
  type TreeStore,
} from '../../packages/db/src/index';
import type { BenchCase } from '../types';

// The person page header asks the server "what is this person to the home
// person" (issue #129: under 100ms on a 10k tree). The first question after
// any write loads the whole tree's families; later ones reuse that graph.
let store: TreeStore;
let ids: string[];
let i = 0;

function loaded() {
  if (store) return;
  const data = generateSyntheticTree({ people: 10_000, seed: 1 });
  store = openMemoryTree();
  bulkInsert(store, data);
  ids = data.person.map((p) => p.id!);
}

const next = () => ids[(i = (i * 7919 + 13) % ids.length)]!;

export default [
  {
    name: 'relationship endpoint: first lookup after a write (10k tree)',
    setup: loaded,
    fn: () => {
      // Any write changes the database version, so the graph is rebuilt.
      store.db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('bench', 'x')");
      return getRelationship(store, next(), ids[0]!);
    },
    budgetMs: 100,
    iterations: 20,
  },
  {
    name: 'relationship endpoint: cached graph (10k tree)',
    setup: loaded,
    fn: () => getRelationship(store, next(), ids[0]!),
    budgetMs: 10,
    iterations: 500,
  },
] satisfies BenchCase[];
