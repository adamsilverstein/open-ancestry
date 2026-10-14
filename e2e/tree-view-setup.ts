import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TREE_EXTENSION,
  bulkInsert,
  createTree,
  generateSyntheticTree,
  meta,
} from '@open-ancestry/db';
import {
  FAMILY_TREE,
  PERF_TREE,
  PERF_TREE_100K,
  SEED_FILE,
  familyRows,
  type PerfTree,
  type SeedInfo,
} from './tree-view-fixtures';

/** Seeds the tree view's synthetic trees into the e2e library. */
export function seedTreeViewTrees(library: string): void {
  mkdirSync(library, { recursive: true });

  const fresh = (name: string) => {
    const dir = join(library, `${name}${TREE_EXTENSION}`);
    rmSync(dir, { recursive: true, force: true });
    return createTree(dir, { name });
  };

  const family = fresh(FAMILY_TREE);
  const { data, ids } = familyRows();
  bulkInsert(family, data);
  family.transact('Set home person', (tx) => meta.setHomePerson(tx, ids.ada!));
  family.close();

  const perfTree = (name: string, people: number): PerfTree => {
    const store = fresh(name);
    const synthetic = generateSyntheticTree({ people, seed: 7 });
    bulkInsert(store, synthetic);
    store.transact('Set home person', (tx) => meta.setHomePerson(tx, synthetic.focusId));
    store.close();
    return {
      tree: name,
      focusId: synthetic.focusId,
      founderId: synthetic.person[0]!.id as string,
      people,
    };
  };

  const seed: SeedInfo = {
    family: { tree: FAMILY_TREE, ids },
    perf: perfTree(PERF_TREE, 10_000),
  };
  if (process.env.OA_PERF_100K === '1') seed.perf100k = perfTree(PERF_TREE_100K, 100_000);
  writeFileSync(join(library, SEED_FILE), JSON.stringify(seed));
}
