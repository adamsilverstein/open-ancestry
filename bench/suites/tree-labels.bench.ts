import { layoutFamily, type TreeGraph, type TreeLayout } from '../../packages/core/src/layout';
import { buildRelations, kinshipLabels } from '../../apps/web/src/tree/relations';
import type { BenchCase } from '../types';

// Every layout also builds the cards' relations and kinship labels (layout
// worker and TreeCanvas). One huge family used to make that cubic (#209), so
// it is budgeted next to the 50ms layout of the same family.
let fromParent: TreeLayout;
let fromChild: TreeLayout;

export default [
  {
    name: 'tree labels: relations and kinship, one couple with 3,000 children',
    setup: () => {
      const kids = Array.from({ length: 3000 }, (_, i) => `k${i}`);
      const graph: TreeGraph = {
        people: Object.fromEntries(
          ['me', 'sp', ...kids].map((id) => [
            id,
            { id, sex: 'U' as const, name: id, living: false },
          ]),
        ),
        families: [{ id: 'F', partners: ['me', 'sp'], children: kids.map((id) => ({ id })) }],
      };
      fromParent = layoutFamily(graph, 'me');
      fromChild = layoutFamily(graph, 'k1500');
    },
    fn: () => {
      kinshipLabels(buildRelations(fromParent), 'me', () => 'U');
      kinshipLabels(buildRelations(fromChild), 'k1500', () => 'U');
    },
    // The mean: a p99 over a few dozen samples swings with machine load.
    metric: 'mean',
    budgetMs: 20,
  },
] satisfies BenchCase[];
