import {
  bulkInsert,
  generateSyntheticTree,
  listPeople,
  openMemoryTree,
  type ListPeopleOptions,
  persons,
  type TreeStore,
} from '../../packages/db/src/index';
import type { BenchCase } from '../types';

// The people list on a 100k tree (issues #41, #114): the first page of a new
// order sorts the whole tree once; later pages slice the cached order.
let store: TreeStore | undefined;
let i = 0;

function loaded() {
  if (store) return;
  store = openMemoryTree();
  bulkInsert(store, generateSyntheticTree({ people: 100_000, seed: 3 }));
}

/** The first page of an order no request has asked for yet: any write invalidates the cache. */
const coldCase = (label: string, options: ListPeopleOptions): BenchCase => ({
  name: `db: people list ${label}, first page after an edit (100k tree)`,
  setup: loaded,
  // Untimed: the write is not part of the list request.
  beforeEach: () => store!.transact('touch', (tx) => persons.create(tx, {})),
  fn: () => listPeople(store!, { ...options, limit: 100 }),
  // Issue #114: under 100ms on 100k (the tree view's interaction budget).
  budgetMs: 100,
  metric: 'mean',
  iterations: 5,
  time: 0,
});

export default [
  coldCase('by birth', { sort: 'birth' }),
  coldCase('by death, newest first', { sort: 'death', direction: 'desc' }),
  coldCase('by given name', { sort: 'given' }),
  coldCase('by surname', { sort: 'surname' }),
  coldCase('by birth, men only', { sort: 'birth', sex: 'M' }),
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
