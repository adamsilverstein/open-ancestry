import { generateGedcom } from '../../fixtures/generate';
import { openMemoryTree } from '../../packages/db/src/index';
import { importGedcom } from '../../packages/import/src/index';
import type { BenchCase } from '../types';

// design.md section 7: a 10k-person Ancestry GEDCOM imports in under 3s,
// 100k in under 30s (parse + map + load + search index, in-memory tree).
const inputs = new Map<number, Uint8Array>();
const input = (people: number) => {
  let bytes = inputs.get(people);
  if (!bytes) {
    bytes = new TextEncoder().encode(generateGedcom({ people, seed: 1 }));
    inputs.set(people, bytes);
  }
  return bytes;
};

async function run(people: number) {
  const store = openMemoryTree();
  const report = await importGedcom({ bytes: input(people) }, store);
  store.close();
  if (report.records.INDI !== people) throw new Error(`imported ${report.records.INDI} people`);
}

export default [
  {
    name: 'import: 10k-person Ancestry GEDCOM',
    setup: () => input(10_000),
    fn: async () => await run(10_000),
    budgetMs: 3000,
    metric: 'mean',
    iterations: 5,
    time: 0,
    warmupIterations: 1,
  },
  {
    name: 'import: 100k-person Ancestry GEDCOM',
    setup: () => input(100_000),
    fn: async () => await run(100_000),
    budgetMs: 30_000,
    metric: 'mean',
    iterations: 1,
    time: 0,
    warmupIterations: 0,
  },
] satisfies BenchCase[];
