import { layoutFamily, layoutFan, layoutPedigree } from '../../packages/core/src/layout';
import { syntheticTree } from '../../packages/core/src/layout/test-graphs';
import type { LayoutOptions, TreeGraph } from '../../packages/core/src/layout';
import type { BenchCase } from '../types';

// Tree re-focus budget (design.md F9 and section 7): layout of 500 visible
// people < 20ms, 5,000 < 150ms. Setup checks the visible count so the
// generator cannot silently drift below the size being budgeted.
function familyCase(
  name: string,
  shape: [number, number, number, number?],
  minVisible: number,
  budgetMs: number,
): BenchCase {
  let graph: TreeGraph;
  let focusId = '';
  const opts: LayoutOptions = {
    ancestorsDepth: shape[0],
    descendantsDepth: shape[1],
    // Siblings (with spouses) beside every ancestor generation when the shape has them.
    siblingsDepth: shape[3] ? shape[0] + 1 : 2,
  };
  return {
    name,
    setup: () => {
      ({ graph, focusId } = syntheticTree(...shape));
      const visible = layoutFamily(graph, focusId, opts).nodes.length;
      if (visible < minVisible) throw new Error(`${name}: only ${visible} visible people`);
    },
    fn: () => layoutFamily(graph, focusId, opts),
    budgetMs,
  };
}

let pedigree: ReturnType<typeof syntheticTree>;

export default [
  familyCase('layout: family view, 500 visible people', [5, 4, 4], 480, 20),
  familyCase('layout: family view, 5,000 visible people', [8, 7, 3], 4800, 150),
  familyCase('layout: family view, 5,300 visible with siblings', [8, 7, 3, 1], 5300, 150),
  {
    name: 'layout: pedigree 10 generations (2,046 people) and 6-generation fan',
    setup: () => {
      pedigree = syntheticTree(10, 0, 0);
    },
    fn: () => {
      layoutPedigree(pedigree.graph, pedigree.focusId, { ancestorsDepth: 10 });
      layoutFan(pedigree.graph, pedigree.focusId);
    },
    budgetMs: 50,
  },
] satisfies BenchCase[];
