import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TREE_EXTENSION,
  bulkInsert,
  createTree,
  generateSyntheticTree,
  meta,
} from '@open-ancestry/db';
import { FAMILY_TREE, PERF_TREE, SEED_FILE, familyRows, type SeedInfo } from './tree-fixtures';

const PERF_PEOPLE = 10_000;

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

  const perf = fresh(PERF_TREE);
  const synthetic = generateSyntheticTree({ people: PERF_PEOPLE, seed: 7 });
  bulkInsert(perf, synthetic);
  perf.transact('Set home person', (tx) => meta.setHomePerson(tx, synthetic.focusId));
  perf.close();

  const seed: SeedInfo = {
    family: { tree: FAMILY_TREE, ids },
    perf: {
      tree: PERF_TREE,
      focusId: synthetic.focusId,
      // The first founder: thousands of descendants within eight generations.
      founderId: synthetic.person[0]!.id as string,
      people: PERF_PEOPLE,
    },
  };
  writeFileSync(join(library, SEED_FILE), JSON.stringify(seed));
}
