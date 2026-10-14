import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { layoutDescendants, layoutFamily, layoutFan, layoutPedigree } from './index';
import { arbGraph, crossings, makeGraph, syntheticTree } from './test-graphs';
import type { FamilySpec } from './test-graphs';
import type { ExpandKey, LayoutNode, Point, TreeLayout } from './types';

const keysOf = (id: string): ExpandKey[] => [`${id}:up`, `${id}:down`, `${id}:siblings`];

const arbCase = arbGraph.chain((graph) =>
  fc.record({
    graph: fc.constant(graph),
    focus: fc.constantFrom(...graph.ids),
    ancestorsDepth: fc.integer({ min: 0, max: 5 }),
    descendantsDepth: fc.integer({ min: 0, max: 5 }),
    siblingsDepth: fc.integer({ min: 0, max: 4 }),
    expanded: fc.subarray(graph.ids.flatMap(keysOf)),
    collapsed: fc.subarray(graph.ids.flatMap(keysOf)),
  }),
);

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

function assertNoOverlap(nodes: LayoutNode[]) {
  const sorted = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (a.y === b.y) expect(b.x - (a.x + a.width)).toBeGreaterThanOrEqual(0);
    // Rows never interleave: a different row starts at least a card height away.
    else expect(b.y - a.y).toBeGreaterThanOrEqual(a.height);
  }
}

const onSegment = ([px, py]: Point, [ax, ay]: Point, [bx, by]: Point) =>
  (ax === bx && px === ax && py >= Math.min(ay, by) && py <= Math.max(ay, by)) ||
  (ay === by && py === ay && px >= Math.min(ax, bx) && px <= Math.max(ax, bx));

/** Every edge endpoint touches the card, couple line or bar it connects. */
function assertVerticalEdges(layout: TreeLayout) {
  const byKey = new Map(layout.nodes.map((n) => [n.key, n]));
  const groups = groupBy(layout.edges, (e) => e.group);
  for (const edges of groups.values()) {
    const couple = edges.find((e) => e.kind === 'couple');
    const drop = edges.find((e) => e.kind === 'parent-child' && e.parents);
    const bar = edges.find((e) => e.kind === 'sibling-bar');
    const childDrops = edges.filter((e) => e.child);
    if (couple) {
      const [l, r] = couple.parents!.map((k) => byKey.get(k)!);
      const first = couple.points[0]!;
      const last = couple.points.at(-1)!;
      if (couple.points.length === 2) {
        expect(first).toEqual([l!.x + l!.width, l!.y + l!.height / 2]);
        expect(last).toEqual([r!.x, r!.y + r!.height / 2]);
      } else {
        // A lane above the row: from the top of the left card to the top of the right one.
        expect(first[1]).toBe(l!.y);
        expect(first[0]).toBeGreaterThan(l!.x + l!.width / 2);
        expect(first[0]).toBeLessThan(l!.x + l!.width);
        expect(last[1]).toBe(r!.y);
        expect(last[0]).toBeGreaterThan(r!.x);
        expect(last[0]).toBeLessThan(r!.x + r!.width / 2);
        expect(couple.points[1]![1]).toBeLessThan(l!.y);
      }
    }
    if (!drop) {
      // Siblings shown without parents: a bar joining two or more children.
      if (childDrops.length === 0) continue;
      expect(childDrops.length).toBeGreaterThan(1);
      for (const e of childDrops) {
        const c = byKey.get(e.child!)!;
        expect(e.points.at(-1)).toEqual([c.x + c.width / 2, c.y]);
        expect(onSegment(e.points[0]!, bar!.points[0]!, bar!.points[1]!)).toBe(true);
      }
      continue;
    }
    const parents = drop.parents!.map((k) => byKey.get(k)!);
    const start = drop.points[0]!;
    const bottoms = parents.map((p) => [p.x + p.width / 2, p.y + p.height]);
    if (parents.length === 1 || couple!.points.length > 2) {
      // One parent, or partners apart: the drop leaves the bottom of a parent card.
      expect(bottoms).toContainEqual(start);
    } else {
      const pts = couple!.points;
      expect(pts.slice(1).some((b, i) => onSegment(start, pts[i]!, b))).toBe(true);
    }
    const barY = drop.points.at(-1)![1];
    for (const e of childDrops) {
      const c = byKey.get(e.child!)!;
      // Parents are above their children.
      for (const p of parents) expect(p.y + p.height).toBeLessThan(c.y);
      expect(c.generation).toBe(parents[0]!.generation + 1);
      expect(e.points).toEqual([
        [c.x + c.width / 2, barY],
        [c.x + c.width / 2, c.y],
      ]);
      if (bar) expect(onSegment(e.points[0]!, bar.points[0]!, bar.points[1]!)).toBe(true);
    }
    if (bar) expect(onSegment(drop.points.at(-1)!, bar.points[0]!, bar.points[1]!)).toBe(true);
  }
}

describe('layout properties', () => {
  it('family layouts never overlap, keep parents above children and connect edges to cards', () => {
    fc.assert(
      fc.property(arbCase, (c) => {
        const layout = layoutFamily(c.graph, c.focus, c);
        expect(layout.nodes.find((n) => n.isFocus)).toMatchObject({ x: 0, y: 0 });
        expect(new Set(layout.nodes.map((n) => n.key)).size).toBe(layout.nodes.length);
        assertNoOverlap(layout.nodes);
        assertVerticalEdges(layout);
        expect(crossings(layout.edges)).toEqual([]);
        const anyRow = layout.nodes.find((n) => n.generation !== 0);
        const rowStep = anyRow ? anyRow.y / anyRow.generation : 0;
        expect(rowStep === 0 || rowStep >= 150 + 64).toBe(true);
        for (const n of layout.nodes) {
          // Rows are evenly spaced (the gap grows only to fit couple lanes).
          expect(n.y).toBe(n.generation * rowStep);
          if (n.isDuplicate) expect(layout.nodes.some((p) => p.key === n.duplicateOf)).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('several spouses, each with children, never cross or share connectors', () => {
    // Up to 6 partners (some unknown) per person, children who remarry too.
    const arbFamilies = fc.array(
      fc.record({ known: fc.boolean(), kids: fc.nat({ max: 4 }), kidSpouses: fc.nat({ max: 3 }) }),
      { minLength: 1, maxLength: 6 },
    );
    fc.assert(
      fc.property(arbFamilies, fc.boolean(), (spec, withParents) => {
        const people: Record<string, 'M' | 'F'> = { me: 'M', dad: 'M', mom: 'F' };
        const fams: FamilySpec[] = withParents ? [['Fp', 'dad', 'mom', ['me']]] : [];
        spec.forEach((f, i) => {
          const kids = Array.from({ length: f.kids }, (_, j) => `k${i}_${j}`);
          for (const kid of kids) people[kid] = 'M';
          if (f.known) people[`w${i}`] = 'F';
          fams.push([`F${i}`, 'me', f.known ? `w${i}` : null, kids]);
          const first = kids[0];
          for (let s = 0; first && s < f.kidSpouses; s++) {
            people[`${first}s${s}`] = 'F';
            people[`${first}s${s}k`] = 'M';
            fams.push([`F${i}_${s}`, first, `${first}s${s}`, [`${first}s${s}k`]]);
          }
        });
        const layout = layoutFamily(makeGraph(people, fams), 'me', { descendantsDepth: 3 });
        assertNoOverlap(layout.nodes);
        assertVerticalEdges(layout);
        expect(crossings(layout.edges)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('descendant and pedigree layouts never overlap', () => {
    fc.assert(
      fc.property(arbCase, (c) => {
        const desc = layoutDescendants(c.graph, c.focus, c);
        assertNoOverlap(desc.nodes);
        assertVerticalEdges(desc);
        expect(desc.nodes.every((n) => n.generation >= 0)).toBe(true);
        const ped = layoutPedigree(c.graph, c.focus, c);
        assertNoOverlap(ped.nodes.map((n) => ({ ...n, x: n.y, y: n.x, width: n.height })));
        for (const e of ped.edges) {
          const child = ped.nodes.find((n) => n.key === e.child)!;
          const parent = ped.nodes.find((n) => n.key === e.parents![0])!;
          expect(parent.x).toBeGreaterThan(child.x);
          expect(e.points[0]).toEqual([child.x + child.width, child.y + child.height / 2]);
          expect(e.points.at(-1)).toEqual([parent.x, parent.y + parent.height / 2]);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('fan segments never overlap', () => {
    fc.assert(
      fc.property(arbCase, (c) => {
        const fan = layoutFan(c.graph, c.focus, c);
        const rings = groupBy(fan.segments, (s) => s.generation);
        for (const ring of rings.values()) {
          const sorted = [...ring].sort((a, b) => a.startAngle - b.startAngle);
          for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i]!.startAngle).toBeGreaterThanOrEqual(sorted[i - 1]!.endAngle - 1e-9);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(arbCase, (c) => {
        expect(layoutFamily(c.graph, c.focus, c)).toEqual(layoutFamily(c.graph, c.focus, c));
        expect(layoutPedigree(c.graph, c.focus, c)).toEqual(layoutPedigree(c.graph, c.focus, c));
        expect(layoutFan(c.graph, c.focus, c)).toEqual(layoutFan(c.graph, c.focus, c));
      }),
      { numRuns: 100 },
    );
  });

  it('terminates on cyclic data with unlimited depth', () => {
    fc.assert(
      fc.property(arbGraph, (g) => {
        for (const id of g.ids) {
          const layout = layoutFamily(g, id, {
            ancestorsDepth: Infinity,
            descendantsDepth: Infinity,
          });
          // Every person appears at most once as a primary card.
          const primaries = layout.nodes.filter((n) => !n.isDuplicate).map((n) => n.personId);
          expect(new Set(primaries).size).toBe(primaries.length);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('keeps a self-parenting person finite', () => {
    const g = {
      people: { a: { id: 'a', sex: 'M' as const, name: 'a', living: false } },
      families: [{ id: 'f', partners: ['a', 'a'] as const, children: [{ id: 'a' }] }],
    };
    const layout = layoutFamily(g, 'a', { ancestorsDepth: Infinity, descendantsDepth: Infinity });
    expect(layout.nodes.map((n) => n.key)).toEqual(['a', 'a~1', 'a~2']);
  });

  it('lays out a 5,000 person tree with siblings at every generation', () => {
    const { graph, focusId } = syntheticTree(8, 7, 3, 1);
    const layout = layoutFamily(graph, focusId, {
      ancestorsDepth: 8,
      descendantsDepth: 7,
      siblingsDepth: 9,
    });
    expect(layout.nodes.length).toBeGreaterThan(5300);
    assertNoOverlap(layout.nodes);
    assertVerticalEdges(layout);
  });
});
