import { generateGedcom } from '../../fixtures/generate';
import type { BenchCase } from '../types';

// Placeholder suite proving the harness; real budgets (design.md section 7)
// are added alongside the features that own each hot path.
export default [
  {
    name: 'fixtures: generate 1k-person GEDCOM',
    fn: () => generateGedcom({ people: 1000, seed: 1 }),
    budgetMs: 50,
  },
] satisfies BenchCase[];
