import {
  bulkInsert,
  generateSyntheticTree,
  getRelationship,
  openMemoryTree,
  type TreeStore,
} from '../../packages/db/src/index';
import { forgetKinship } from '../../packages/db/src/kinship';
import type { BenchCase } from '../types';

// The person page header asks the server "what is this person to the home
// person" (issue #129: under 100ms). The graph is read lazily, as far as a
// lookup walks, and an edit only drops the rows it touched.
interface Tree {
  store: TreeStore;
  ids: string[];
  links: string[];
}
const trees = new Map<number, Tree>();
let i = 0;

function tree(people: number): Tree {
  let t = trees.get(people);
  if (!t) {
    const data = generateSyntheticTree({ people, seed: 3 });
    const store = openMemoryTree();
    bulkInsert(store, data);
    t = { store, ids: data.person.map((p) => p.id!), links: data.family_child.map((c) => c.id!) };
    trees.set(people, t);
  }
  return t;
}

const next = (t: Tree) => t.ids[(i = (i * 7919 + 13) % t.ids.length)]!;

const cases = (people: number, label: string, cachedBudget: number): BenchCase[] => [
  {
    name: `relationship endpoint: first lookup, nothing cached (${label})`,
    setup: () => tree(people),
    fn: () => {
      const t = tree(people);
      forgetKinship(t.store);
      return getRelationship(t.store, next(t), t.ids[0]!);
    },
    budgetMs: 100,
    iterations: 10,
    time: 0,
  },
  {
    name: `relationship endpoint: first lookup after a family edit (${label})`,
    setup: () => getRelationship(tree(people).store, tree(people).ids[1]!, tree(people).ids[0]!),
    fn: () => {
      const t = tree(people);
      const link = t.links[i % t.links.length]!;
      const rel = i % 2 ? 'biological' : 'step';
      t.store.db.prepare('UPDATE family_child SET partner1_rel = ? WHERE id = ?').run(rel, link);
      return getRelationship(t.store, next(t), t.ids[0]!);
    },
    budgetMs: 100,
    iterations: 100,
  },
  {
    name: `relationship endpoint: cached graph (${label})`,
    setup: () => getRelationship(tree(people).store, tree(people).ids[1]!, tree(people).ids[0]!),
    fn: () => {
      const t = tree(people);
      return getRelationship(t.store, next(t), t.ids[0]!);
    },
    budgetMs: cachedBudget,
    iterations: 500,
  },
];

export default [
  ...cases(10_000, '10k tree', 10),
  // A third of these random pairs are in-laws found by a marriage-path search.
  ...cases(100_000, '100k tree', 50),
] satisfies BenchCase[];
