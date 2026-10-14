import { generateGedcom } from '../../fixtures/generate';
import { openMemoryTree, type TreeStore } from '../../packages/db/src/index';
import { exportGedcom, exportGedzip } from '../../packages/export/src/index';
import { importGedcom } from '../../packages/import/src/index';
import type { BenchCase } from '../types';

// Export of a 10k-person tree stays under a second (issue #16): copied
// records for an unedited 5.5.1 export, every record generated for GEDCOM 7
// and for a privatized export.
let store: TreeStore | undefined;
async function tree(): Promise<TreeStore> {
  if (!store) {
    store = openMemoryTree();
    await importGedcom({ bytes: generateGedcom({ people: 10_000, seed: 1 }) }, store);
  }
  return store;
}

// 3,000 records the importer does not map are written once each (review of #46: this was
// quadratic, 5.4s for a 5k-person tree).
let rawOnly: TreeStore | undefined;
async function rawOnlyTree(): Promise<TreeStore> {
  if (!rawOnly) {
    const extra = Array.from({ length: 3000 }, (_, i) => `0 @X${i}@ _FOO\n1 _BAR ${i}`).join('\n');
    const gedcom = generateGedcom({ people: 5_000, seed: 2 }).replace(
      /0 TRLR\s*$/,
      `${extra}\n0 TRLR\n`,
    );
    rawOnly = openMemoryTree();
    const report = await importGedcom({ bytes: gedcom }, rawOnly);
    if (report.records._FOO !== 3000)
      throw new Error(`imported ${report.records._FOO} _FOO records`);
  }
  return rawOnly;
}

const exportCase = (name: string, fn: (store: TreeStore) => unknown): BenchCase => ({
  name: `export: ${name}`,
  setup: tree,
  fn: () => fn(store!),
  budgetMs: 1000,
  metric: 'mean',
  iterations: 5,
  time: 0,
  warmupIterations: 1,
});

export default [
  exportCase('10k-person tree as GEDCOM 5.5.1 (verbatim)', (s) => exportGedcom(s)),
  exportCase('10k-person tree as GEDCOM 7 (generated)', (s) => exportGedcom(s, { version: '7' })),
  exportCase('10k-person tree as GEDCOM 5.5.1, living privatized', (s) =>
    exportGedcom(s, { privatizeLiving: true }),
  ),
  exportCase('10k-person tree as GEDZIP', (s) => exportGedzip(s)),
  {
    ...exportCase('5k-person tree with 3k unmapped records as GEDCOM 7', () =>
      exportGedcom(rawOnly!, { version: '7' }),
    ),
    setup: rawOnlyTree,
  },
] satisfies BenchCase[];
