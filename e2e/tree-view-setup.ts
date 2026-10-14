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

  const perfTree = (name: string, people: number, seed: number, pick: 'founder' | 'widest') => {
    const store = fresh(name);
    const synthetic = generateSyntheticTree({ people, seed });
    bulkInsert(store, synthetic);
    store.transact('Set home person', (tx) => meta.setHomePerson(tx, synthetic.focusId));
    store.close();
    return {
      tree: name,
      focusId: synthetic.focusId,
      wideId: pick === 'founder' ? (synthetic.person[0]!.id as string) : widestPerson(synthetic),
      people,
    } satisfies PerfTree;
  };

  const seed: SeedInfo = {
    family: { tree: FAMILY_TREE, ids },
    perf: perfTree(PERF_TREE, 10_000, 7, 'founder'),
  };
  // Another seed, so its first 10,000 people are not the 10k tree, and the
  // densest view in it, so the 100k checks lay out more than the 10k ones.
  if (process.env.OA_PERF_100K === '1') {
    seed.perf100k = perfTree(PERF_TREE_100K, 100_000, 11, 'widest');
  }
  writeFileSync(join(library, SEED_FILE), JSON.stringify(seed));
}

/**
 * Among the early generations, the person with the most descendants within
 * eight generations whose nine-generation slice stays under the neighborhood
 * endpoint's 5,000-person cap.
 */
function widestPerson(tree: ReturnType<typeof generateSyntheticTree>): string {
  const families = new Map<string, string[]>();
  for (const f of tree.family) {
    for (const p of [f.partner1_id, f.partner2_id]) {
      if (p) families.set(p, [...(families.get(p) ?? []), f.id as string]);
    }
  }
  const children = new Map<string, string[]>();
  for (const c of tree.family_child) {
    children.set(c.family_id, [...(children.get(c.family_id) ?? []), c.child_id]);
  }
  const descendants = (id: string, generations: number) => {
    let frontier = [id];
    let total = 0;
    for (let g = 0; g < generations; g++) {
      frontier = frontier.flatMap((p) =>
        (families.get(p) ?? []).flatMap((f) => children.get(f) ?? []),
      );
      total += frontier.length;
    }
    return total;
  };
  let best = tree.person[0]!.id as string;
  let most = 0;
  for (const person of tree.person.slice(0, 3000)) {
    const id = person.id as string;
    const count = descendants(id, 8);
    if (count > most && descendants(id, 9) < 4800) {
      best = id;
      most = count;
    }
  }
  return best;
}
