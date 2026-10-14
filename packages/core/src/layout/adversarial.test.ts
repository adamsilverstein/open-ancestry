/** Adversarial checks ported from the PR #25 review. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { layoutFamily, layoutFan, layoutPedigree } from './index';
import { arbGraph, cousinMarriage, crossings, makeGraph, syntheticTree } from './test-graphs';
import type { FamilySpec } from './test-graphs';
import type { LayoutNode, TreeLayout } from './types';

const center = (n: LayoutNode) => n.x + n.width / 2;

/** `me` married five times; spouse i has i + 1 children. */
function fiveSpouses() {
  const fams: FamilySpec[] = [['Fp', 'dad', 'mom', ['me']]];
  const people: Record<string, 'M' | 'F'> = { me: 'M', dad: 'M', mom: 'F' };
  for (let i = 0; i < 5; i++) {
    people[`w${i}`] = 'F';
    const kids = Array.from({ length: i + 1 }, (_, j) => `k${i}_${j}`);
    for (const kid of kids) people[kid] = 'M';
    fams.push([`F${i}`, 'me', `w${i}`, kids]);
  }
  return { people, fams };
}

describe('crossings', () => {
  it('reports crossings and overlaps between families, not within one couple', () => {
    const edge = (group: string, points: [number, number][], parents?: string[]) => ({
      kind: 'parent-child' as const,
      familyId: group,
      group,
      points,
      ...(parents ? { parents } : {}),
    });
    expect(
      crossings([
        edge('a', [
          [0, 0],
          [10, 0],
        ]),
        edge('b', [
          [5, -5],
          [5, 5],
        ]),
        edge('c', [
          [8, 0],
          [20, 0],
        ]),
        edge('d', [
          [5, 1],
          [5, 3],
        ]),
        edge(
          'e',
          [
            [30, 0],
            [30, 9],
          ],
          ['x', 'y'],
        ),
        edge(
          'f',
          [
            [30, 0],
            [30, 9],
          ],
          ['y', 'x'],
        ),
      ]),
    ).toEqual(['cross a x b @5,0', 'overlap a c', 'overlap b d']);
  });
});

describe('adversarial layouts', () => {
  it('centers each ancestor under its parents, father left, paternal side left', () => {
    const { graph, focusId } = syntheticTree(6, 0, 0);
    const layout = layoutFamily(graph, focusId, { ancestorsDepth: 6 });
    const by = new Map(layout.nodes.map((n) => [n.key, n]));
    for (const e of layout.edges.filter((x) => x.kind === 'couple')) {
      const [f, m] = e.parents!.map((k) => by.get(k)!);
      const child = layout.edges.find((x) => x.group === e.group && x.child)!;
      expect(center(by.get(child.child!)!)).toBeCloseTo((center(f!) + center(m!)) / 2);
      expect(Number(f!.personId.slice(1)) % 2).toBe(0);
    }
    const side = (id: string) => {
      let n = Number(id.slice(1));
      while (n > 3) n = Math.floor(n / 2);
      return n;
    };
    for (const y of new Set(layout.nodes.map((n) => n.y))) {
      const row = layout.nodes.filter((n) => n.y === y && n.generation < 0);
      const pat = row.filter((n) => side(n.personId) === 2).map((n) => n.x);
      const mat = row.filter((n) => side(n.personId) === 3).map((n) => n.x);
      if (pat.length && mat.length) expect(Math.max(...pat)).toBeLessThan(Math.min(...mat));
    }
    expect(crossings(layout.edges)).toEqual([]);
  });

  it('never draws a straight couple connector across another card', () => {
    fc.assert(
      fc.property(arbGraph, fc.nat(), (g, k) => {
        const focus = g.ids[k % g.ids.length]!;
        const layout = layoutFamily(g, focus, { ancestorsDepth: 4, descendantsDepth: 4 });
        const by = new Map(layout.nodes.map((n) => [n.key, n]));
        for (const e of layout.edges.filter((x) => x.kind === 'couple')) {
          const [l, r] = e.parents!.map((key) => by.get(key)!);
          expect(l!.y).toBe(r!.y);
          if (e.points.length === 2) {
            expect(layout.nodes.filter((n) => n.y === l!.y && n.x > l!.x && n.x < r!.x)).toEqual(
              [],
            );
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('keeps every family of a five-times-married person apart', () => {
    const { people, fams } = fiveSpouses();
    const layout = layoutFamily(makeGraph(people, fams), 'me');
    expect(crossings(layout.edges)).toEqual([]);
    // Each family's bar spans only its own children.
    for (let i = 0; i < 5; i++) {
      const bar = layout.edges.find((e) => e.kind === 'sibling-bar' && e.familyId === `F${i}`);
      const kids = layout.nodes.filter((n) => n.key.startsWith(`k${i}_`)).map(center);
      if (bar)
        expect([bar.points[0]![0], bar.points[1]![0]]).toEqual([
          Math.min(...kids),
          Math.max(...kids),
        ]);
    }
    // The same person one generation down.
    const g2 = makeGraph({ ...people, top: 'M', topw: 'F' }, [
      ['Ftop', 'top', 'topw', ['me', 'dad']],
      ...fams.filter((f) => f[0] !== 'Fp'),
    ]);
    expect(crossings(layoutFamily(g2, 'top', { descendantsDepth: 3 }).edges)).toEqual([]);
  });

  it('fan rings nest by Ahnentafel number and fill the sweep', () => {
    const { graph, focusId } = syntheticTree(6, 0, 0);
    const fan = layoutFan(graph, focusId);
    const byA = new Map(fan.segments.map((s) => [s.ahnentafel, s]));
    for (const s of fan.segments) {
      if (s.ahnentafel === 1) continue;
      const child = byA.get(Math.floor(s.ahnentafel / 2))!;
      expect(s.startAngle).toBeGreaterThanOrEqual(child.startAngle - 1e-9);
      expect(s.endAngle).toBeLessThanOrEqual(child.endAngle + 1e-9);
      expect(s.innerRadius).toBe(child.outerRadius);
      expect(s.personId).toBe(`a${s.ahnentafel}`);
    }
    for (let g = 0; g < 6; g++) {
      const ring = fan.segments.filter((s) => s.generation === g);
      expect(ring.reduce((a, s) => a + s.endAngle - s.startAngle, 0)).toBeCloseTo(Math.PI);
    }
    expect(fan.segments).toHaveLength(63);
    expect(layoutFan(cousinMarriage, 'me').segments.filter((s) => s.isDuplicate)).toHaveLength(2);
  });

  it('handles a family with 3,000 children in linear time', () => {
    const people: Record<string, 'M' | 'F'> = { me: 'M', sp: 'F' };
    const kids = Array.from({ length: 3000 }, (_, i) => `k${i}`);
    for (const k of kids) people[k] = 'M';
    const g = makeGraph(people, [['F', 'me', 'sp', kids]]);
    const layout = layoutFamily(g, 'me');
    const xs = layout.nodes
      .filter((n) => n.generation === 1)
      .map((n) => n.x)
      .sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(120);
    const couple = layout.edges.find((e) => e.kind === 'couple')!;
    expect((couple.points[0]![0] + couple.points[1]![0]) / 2).toBeCloseTo(
      (xs[0]! + xs.at(-1)! + 120) / 2,
    );
  });

  it('terminates on a 3,000-deep pedigree chain', () => {
    const people: Record<string, 'M'> = {};
    const fams: FamilySpec[] = [];
    for (let i = 0; i < 3000; i++) people[`p${i}`] = 'M';
    for (let i = 0; i < 2999; i++) fams.push([`f${i}`, `p${i + 1}`, null, [`p${i}`]]);
    const l = layoutPedigree(makeGraph(people, fams), 'p0', { ancestorsDepth: Infinity });
    expect(l.nodes).toHaveLength(3000);
  });

  it('expanding an ancestor never moves the focus row or descendants', () => {
    const { graph, focusId } = syntheticTree(6, 3, 2);
    const pos = (l: TreeLayout) =>
      Object.fromEntries(l.nodes.filter((n) => n.generation >= 0).map((n) => [n.key, [n.x, n.y]]));
    const a = layoutFamily(graph, focusId, { ancestorsDepth: 2 });
    const b = layoutFamily(graph, focusId, { ancestorsDepth: 2, expanded: ['a4:up'] });
    expect(pos(b)).toEqual(pos(a));
    const c = layoutFamily(graph, focusId, { ancestorsDepth: 2, collapsed: ['a1:down'] });
    expect(c.nodes.filter((n) => n.generation > 0)).toEqual([]);
  });
});
