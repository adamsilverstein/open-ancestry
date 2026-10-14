/** Issue #42: parentless families beside real ones, and cached repeated queries. */
import { describe, expect, it } from 'vitest';
import { kinshipGraph, relationship, relationshipCalculator } from './index';
import type { KinshipGraph } from './index';
import { bigFamily, GraphBuilder, randomTree } from './test-family';

describe('parentless families beside real ones', () => {
  const g = kinshipGraph(
    new GraphBuilder()
      .person('dad', 'M')
      .person('mom', 'F')
      .person('stepmom', 'F')
      .person('me', 'F')
      .person('sib', 'M')
      .person('only', 'M')
      .person('x', 'M')
      .person('half', 'M')
      .family('F1', 'dad', 'mom', ['me', 'sib', 'only'])
      .family('F2', null, null, ['me', 'sib', 'x', 'half'])
      .family('F3', 'dad', 'stepmom', ['half'])
      .build(),
  );

  it('keeps siblings in both a real and a parentless family full', () => {
    const r = relationship(g, 'sib', 'me');
    expect(r.name).toBe('brother');
    expect(r.relationships[0]!.half).toBe(false);
  });

  it('ignores a parentless family only one of them is in', () => {
    expect(relationship(g, 'only', 'me').name).toBe('brother');
  });

  it('does not call siblings half without known parents to compare', () => {
    expect(relationship(g, 'x', 'me').name).toBe('brother');
  });

  it('still finds half siblings through their known parents', () => {
    expect(relationship(g, 'half', 'me').name).toBe('half brother');
  });
});

/** Counts parent lookups, to see the cache at work. */
function counting(g: KinshipGraph) {
  const counter = { parents: 0 };
  const wrapped: KinshipGraph = {
    ...g,
    parents: (id) => {
      counter.parents++;
      return g.parents(id);
    },
  };
  return { wrapped, counter };
}

describe('relationshipCalculator', () => {
  it('gives the same answers as relationship()', () => {
    const { graph, ids } = randomTree(300, 5);
    const g = kinshipGraph(graph);
    const calc = relationshipCalculator(g);
    for (let i = 0; i < 200; i++) {
      const a = ids[(i * 7) % ids.length]!;
      const b = ids[(i * 13 + 3) % ids.length]!;
      expect(calc(a, b)).toEqual(relationship(g, a, b));
    }
  });

  it('walks each person’s ancestors once across queries', () => {
    const { wrapped, counter } = counting(kinshipGraph(bigFamily()));
    const calc = relationshipCalculator(wrapped);
    calc('cousin1', 'me');
    const first = counter.parents;
    calc('cousin1', 'me');
    // Both walks come from the cache; only the half check looks at two parents.
    expect(counter.parents - first).toBeLessThanOrEqual(2);
    expect(first).toBeGreaterThan(8);
    expect(calc('gc3', 'me', { style: 'formal' }).name).toBe('2nd cousin once removed');
  });

  it('forgets the least recently used people past its size', () => {
    const { wrapped, counter } = counting(kinshipGraph(bigFamily()));
    const calc = relationshipCalculator(wrapped, { cacheSize: 2 });
    calc('cousin1', 'me');
    calc('gc3', 'son');
    const before = counter.parents;
    calc('cousin1', 'me');
    expect(counter.parents).toBeGreaterThan(before);
  });
});
