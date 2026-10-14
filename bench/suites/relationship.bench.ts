import {
  kinshipGraph,
  relationship,
  relationshipCalculator,
} from '../../packages/core/src/relationship';
import type { KinshipGraph } from '../../packages/core/src/relationship';
import { randomTree } from '../../packages/core/src/relationship/test-family';
import type { BenchCase } from '../types';

// Relationship calculator (issue #15): any-to-any in a 10k-person tree under
// 10ms. Each call computes one pair, cycling through random pairs, so the
// p99 covers the slow cases (distant cousins, in-law searches, unrelated).
let graph: KinshipGraph;
let pairs: [string, string][] = [];
let next = 0;
let calc: ReturnType<typeof relationshipCalculator>;
let everyone: string[] = [];

export default [
  {
    name: 'relationship: any-to-any in a 10k-person tree',
    setup: () => {
      const tree = randomTree(10_000, 7);
      if (tree.ids.length < 10_000) throw new Error(`only ${tree.ids.length} people`);
      graph = kinshipGraph(tree.graph);
      let seed = 42;
      const pick = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return tree.ids[seed % tree.ids.length]!;
      };
      pairs = Array.from({ length: 1000 }, () => [pick(), pick()]);
    },
    fn: () => {
      const [a, b] = pairs[next++ % pairs.length]!;
      return relationship(graph, a, b);
    },
    budgetMs: 10,
    iterations: 1000,
  },
  {
    // The person page asks "what is X to the home person" for one person
    // after another; the calculator caches the home person's walk.
    name: 'relationship: home person to everyone, cached calculator, 10k tree',
    setup: () => {
      const tree = randomTree(10_000, 7);
      graph = kinshipGraph(tree.graph);
      calc = relationshipCalculator(graph);
      everyone = tree.ids;
      next = 0;
    },
    fn: () => calc(everyone[next++ % everyone.length]!, everyone[0]!),
    budgetMs: 10,
    iterations: 1000,
  },
] satisfies BenchCase[];
