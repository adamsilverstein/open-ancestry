import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TREE_EXTENSION,
  bulkInsert,
  createTree,
  generateSyntheticTree,
  meta,
} from '@open-ancestry/db';
import { importGedcom } from '@open-ancestry/import';
import {
  BIG_FAMILY_TREE,
  FAMILY_TREE,
  CHILDREN_GAP_TREE,
  FAN_NAMES_TREE,
  childrenGapGedcom,
  SAMPLE_TREE,
  fanNamesGedcom,
  PERF_TREE,
  PERF_TREE_100K,
  SEED_FILE,
  bigFamilyRows,
  familyRows,
  type PerfTree,
  type SeedInfo,
} from './tree-view-fixtures';

/** Seeds the tree view's synthetic trees into the e2e library. */
export async function seedTreeViewTrees(library: string): Promise<void> {
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

  // The Ancestry sample, for its step, adoptive and multi-parent links.
  const sampleStore = fresh(SAMPLE_TREE);
  await importGedcom(
    { bytes: readFileSync(join(import.meta.dirname, '..', 'fixtures', 'ancestry-sample.ged')) },
    sampleStore,
  );
  const sampleIds = Object.fromEntries(
    sampleStore.db
      .prepare<[], { given: string; person_id: string }>(
        "SELECT given, person_id FROM person_name WHERE type = 'birth' AND given IS NOT NULL",
      )
      .all()
      .map((row) => [row.given, row.person_id]),
  );
  sampleStore.close();

  // Hard names for the fan; Ann Lee (I1) is the focus.
  const fanStore = fresh(FAN_NAMES_TREE);
  await importGedcom({ bytes: Buffer.from(fanNamesGedcom()) }, fanStore);
  const fanFocus = fanStore.db
    .prepare<[], { person_id: string }>("SELECT person_id FROM person_name WHERE given = 'Ann'")
    .get()!.person_id;
  fanStore.close();

  // A grandparent whose children are only partly loaded by earlier slices (#270).
  const gapStore = fresh(CHILDREN_GAP_TREE);
  await importGedcom({ bytes: Buffer.from(childrenGapGedcom()) }, gapStore);
  const gapIds = Object.fromEntries(
    gapStore.db
      .prepare<[], { given: string; person_id: string }>(
        "SELECT given, person_id FROM person_name WHERE type = 'birth' AND given IS NOT NULL",
      )
      .all()
      .map((row) => [row.given, row.person_id]),
  );
  gapStore.close();

  const seed: SeedInfo = {
    family: { tree: FAMILY_TREE, ids },
    sample: { tree: SAMPLE_TREE, ids: sampleIds },
    fanNames: { tree: FAN_NAMES_TREE, focusId: fanFocus },
    childrenGap: { tree: CHILDREN_GAP_TREE, ids: gapIds },
    perf: perfTree(PERF_TREE, 10_000, 7, 'founder'),
  };
  // Another seed, so its first 10,000 people are not the 10k tree, and the
  // densest view in it, so the 100k checks lay out more than the 10k ones.
  if (process.env.OA_PERF_100K === '1') {
    seed.perf100k = perfTree(PERF_TREE_100K, 100_000, 11, 'widest');
  }
  if (process.env.OA_PERF === '1') {
    const big = fresh(BIG_FAMILY_TREE);
    bulkInsert(big, bigFamilyRows(2_000));
    big.transact('Set home person', (tx) => meta.setHomePerson(tx, 'p-big-father'));
    big.close();
    seed.bigFamily = { tree: BIG_FAMILY_TREE, fatherId: 'p-big-father', people: 2_002 };
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
