import {
  bulkInsert,
  generateSyntheticTree,
  listPeople,
  openMemoryTree,
  persons,
  type TreeStore,
} from '../../packages/db/src/index';
import type { BenchCase } from '../types';

// The people list on a 100k tree (issue #41): the first page of a new order
// sorts the whole tree once; later pages slice the cached order.
let store: TreeStore | undefined;
let i = 0;

function loaded() {
  if (store) return;
  store = openMemoryTree();
  bulkInsert(store, generateSyntheticTree({ people: 100_000, seed: 3 }));
}

export default [
  {
    name: 'db: people list by birth, first page after an edit (100k tree)',
    setup: loaded,
    fn: () => {
      // Any write invalidates the cached order, so this measures a full sort.
      store!.transact('touch', (tx) => persons.create(tx, {}));
      listPeople(store!, { sort: 'birth', limit: 100 });
    },
    budgetMs: 250,
    metric: 'mean',
    iterations: 5,
    time: 0,
  },
  {
    name: 'db: people list page deep in a 100k tree (cached order)',
    setup: () => {
      loaded();
      listPeople(store!, { sort: 'birth', limit: 100 });
    },
    fn: () => listPeople(store!, { sort: 'birth', limit: 100, offset: (i++ % 1000) * 100 }),
    budgetMs: 5,
  },
] satisfies BenchCase[];
