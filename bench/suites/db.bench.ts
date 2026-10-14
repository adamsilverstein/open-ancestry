import {
  bulkInsert,
  generateSyntheticTree,
  getNeighborhood,
  getPersonDetail,
  openMemoryTree,
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
    budgetMs: 1000,
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
] satisfies BenchCase[];
