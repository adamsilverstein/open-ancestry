import { describe, expect, it } from 'vitest';
import { expandKey, layoutDescendants, layoutFamily } from './index';
import {
  adoption,
  cousinMarriage,
  describeLayout,
  halfSiblings,
  makeGraph,
  multipleSpouses,
  nuclear,
  threeGenerations,
} from './test-graphs';
import type { LayoutNode, TreeLayout, TreePerson } from './types';

const node = (layout: TreeLayout, key: string): LayoutNode => {
  const found = layout.nodes.find((n) => n.key === key);
  if (!found) throw new Error(`no node ${key}`);
  return found;
};
const centerX = (n: LayoutNode) => n.x + n.width / 2;

describe('layoutFamily', () => {
  it('lays out a nuclear family', () => {
    const layout = layoutFamily(nuclear, 'me');
    expect(describeLayout(layout)).toMatchSnapshot();

    const me = node(layout, 'me');
    const sp = node(layout, 'sp');
    expect([me.x, me.y]).toEqual([0, 0]);
    expect(me.isFocus).toBe(true);
    // Partners sit side by side, husband on the left.
    expect(sp.y).toBe(0);
    expect(sp.x).toBe(me.width + 16);
    // Parents above, children below, each generation one row apart.
    expect(node(layout, 'dad').y).toBe(-(150 + 64));
    expect(node(layout, 'kid1').y).toBe(150 + 64);
    expect(node(layout, 'dad').generation).toBe(-1);
    expect(node(layout, 'kid1').generation).toBe(1);
    // The parents' couple midpoint is centered over the focus person.
    const dad = node(layout, 'dad');
    const mom = node(layout, 'mom');
    expect(dad.x).toBeLessThan(mom.x);
    expect((centerX(dad) + centerX(mom)) / 2).toBe(centerX(me));
    // Children are centered under the couple.
    const kids = [node(layout, 'kid1'), node(layout, 'kid2')];
    expect((centerX(kids[0]!) + centerX(kids[1]!)) / 2).toBe((centerX(me) + centerX(sp)) / 2);
    expect(layout.labels.map((l) => l.text)).toEqual(['Parents', 'Children']);
  });

  it('draws couple connectors and sibling bars', () => {
    const layout = layoutFamily(nuclear, 'me');
    const me = node(layout, 'me');
    const sp = node(layout, 'sp');
    const couple = layout.edges.find((e) => e.kind === 'couple' && e.familyId === 'F_me')!;
    expect(couple.points).toEqual([
      [me.x + me.width, me.height / 2],
      [sp.x, sp.height / 2],
    ]);
    const bar = layout.edges.find((e) => e.kind === 'sibling-bar' && e.familyId === 'F_me')!;
    const kid1 = node(layout, 'kid1');
    const kid2 = node(layout, 'kid2');
    expect(bar.points).toEqual([
      [centerX(kid1), kid1.y - 32],
      [centerX(kid2), kid1.y - 32],
    ]);
    const drops = layout.edges.filter((e) => e.child && e.familyId === 'F_me');
    expect(drops.map((e) => e.child)).toEqual(['kid1', 'kid2']);
    expect(drops[0]!.points.at(-1)).toEqual([centerX(kid1), kid1.y]);
  });

  it('lays out three generations of ancestors, paternal left and maternal right', () => {
    const layout = layoutFamily(threeGenerations, 'me');
    expect(describeLayout(layout)).toMatchSnapshot();
    const xs = (keys: string[]) => keys.map((k) => node(layout, k).x);
    const gg = ['pgf_f', 'pgf_m', 'pgm_f', 'pgm_m', 'mgf_f', 'mgf_m', 'mgm_f', 'mgm_m'];
    expect(xs(gg)).toEqual([...xs(gg)].sort((a, b) => a - b));
    expect(xs(['pgf', 'pgm', 'mgf', 'mgm'])).toEqual(
      [...xs(['pgf', 'pgm', 'mgf', 'mgm'])].sort((a, b) => a - b),
    );
    expect(layout.labels.map((l) => [l.generation, l.text])).toEqual([
      [-3, 'Great-grandparents'],
      [-2, 'Grandparents'],
      [-1, 'Parents'],
    ]);
    // Grandparents are not expandable beyond the slice; great-grandparents have nothing above.
    expect(node(layout, 'pgf_f').canExpandUp).toBe(false);
    expect(node(layout, 'pgf').canCollapseUp).toBe(true);
  });

  it('honours the ancestor depth and offers expand chevrons at the edge', () => {
    const layout = layoutFamily(threeGenerations, 'me', { ancestorsDepth: 1 });
    expect(layout.nodes.map((n) => n.key).sort()).toEqual(['dad', 'me', 'mom']);
    expect(node(layout, 'dad').canExpandUp).toBe(true);
    expect(node(layout, 'me').canCollapseUp).toBe(true);
  });

  it('expands and collapses without moving the focus person', () => {
    const base = layoutFamily(threeGenerations, 'me', { ancestorsDepth: 1 });
    const expanded = layoutFamily(threeGenerations, 'me', {
      ancestorsDepth: 1,
      expanded: [expandKey('dad', 'up')],
    });
    expect(expanded.nodes.map((n) => n.key)).toContain('pgf_f');
    expect(expanded.nodes.map((n) => n.key)).not.toContain('mgf');
    const collapsed = layoutFamily(threeGenerations, 'me', { collapsed: [expandKey('me', 'up')] });
    expect(collapsed.nodes.map((n) => n.key)).toEqual(['me']);
    expect(node(collapsed, 'me').canExpandUp).toBe(true);
    for (const l of [base, expanded, collapsed]) {
      expect([node(l, 'me').x, node(l, 'me').y]).toEqual([0, 0]);
    }
  });

  it('collapses descendants but keeps the spouse beside the focus person', () => {
    const layout = layoutFamily(nuclear, 'me', { collapsed: ['me:down'] });
    expect(layout.nodes.map((n) => n.key).sort()).toEqual(['dad', 'me', 'mom', 'sp']);
    expect(node(layout, 'me').canExpandDown).toBe(true);
    expect(layout.edges.filter((e) => e.kind === 'couple')).toHaveLength(2);
  });

  it('groups children under each spouse for several marriages', () => {
    const layout = layoutFamily(multipleSpouses, 'me');
    expect(describeLayout(layout)).toMatchSnapshot();
    const order = layout.nodes
      .filter((n) => n.generation === 0)
      .sort((a, b) => a.x - b.x)
      .map((n) => n.key);
    expect(order).toEqual(['w1', 'me', 'w2', 'w3']);
    // Each couple's children sit in their own group, ordered like the couples.
    const kidsX = (keys: string[]) => keys.map((k) => centerX(node(layout, k)));
    const xs = kidsX(['a1', 'a2', 'u1', 'b1', 'c1', 'c2']);
    expect(xs).toEqual([...xs].sort((p, q) => p - q));
    const dropX = (familyId: string) =>
      layout.edges.find((e) => e.familyId === familyId && e.parents && e.kind === 'parent-child')!
        .points[0]![0];
    const drops = ['F1', 'F4', 'F2', 'F3'].map(dropX);
    expect(drops).toEqual([...drops].sort((p, q) => p - q));
    // The third wife is not adjacent, so that couple line drops below the row.
    const third = layout.edges.find((e) => e.kind === 'couple' && e.familyId === 'F3')!;
    expect(third.points).toHaveLength(4);
    expect(third.points[1]![1]).toBeGreaterThan(150);
    // Children with an unknown partner drop from the focus card itself.
    const unknown = layout.edges.find((e) => e.familyId === 'F4' && e.parents)!;
    expect(unknown.points[0]).toEqual([centerX(node(layout, 'me')), 150]);
  });

  it('prefers biological parents and exposes the alternates for a switcher', () => {
    const layout = layoutFamily(adoption, 'me');
    expect(describeLayout(layout)).toMatchSnapshot();
    expect(layout.nodes.map((n) => n.key)).toContain('bdad');
    expect(layout.nodes.map((n) => n.key)).not.toContain('adad');
    expect(layout.alternateParentFamilies).toEqual({
      me: { selected: 'F_bio', families: ['F_adopt', 'F_bio'] },
    });
    expect(layout.edges.find((e) => e.child === 'kid')?.rel).toBe('adopted');

    const switched = layoutFamily(adoption, 'me', { selectedParentFamilies: { me: 'F_adopt' } });
    expect(switched.nodes.map((n) => n.key)).toContain('adad');
    expect(switched.alternateParentFamilies['me']?.selected).toBe('F_adopt');
    expect(switched.edges.find((e) => e.child === 'me')?.rel).toBe('adopted');
  });

  it('renders pedigree collapse as linked duplicates without recursing', () => {
    const layout = layoutFamily(cousinMarriage, 'me', { ancestorsDepth: 5 });
    expect(describeLayout(layout)).toMatchSnapshot();
    const dups = layout.nodes.filter((n) => n.isDuplicate);
    expect(dups.map((n) => [n.key, n.duplicateOf])).toEqual([
      ['ggf~1', 'ggf'],
      ['ggm~1', 'ggm'],
    ]);
    expect(dups.every((n) => !n.canExpandUp && !n.canCollapseUp)).toBe(true);
    expect(new Set(layout.nodes.map((n) => n.key)).size).toBe(layout.nodes.length);
  });

  it('shows half siblings under their own couples', () => {
    const layout = layoutFamily(halfSiblings, 'dad');
    expect(describeLayout(layout)).toMatchSnapshot();
    const order = layout.nodes
      .filter((n) => n.generation === 1)
      .sort((a, b) => a.x - b.x)
      .map((n) => n.key);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(layout.labels.map((l) => l.text)).toEqual(['Children', 'Grandchildren']);
    expect(node(layout, 'c').canCollapseDown).toBe(true);
    expect(node(layout, 'ck').canExpandDown).toBe(false);
  });

  it('places a female focus person right of her husband', () => {
    const g = makeGraph({ me: 'F', h: 'M' }, [['F', 'h', 'me', []]]);
    const layout = layoutFamily(g, 'me');
    expect(node(layout, 'h').x).toBeLessThan(0);
  });

  it('expands a spouse to show their parents next to the focus parents', () => {
    const g = makeGraph({ me: 'M', sp: 'F', a: 'M', b: 'F', c: 'M', d: 'F' }, [
      ['F_me', 'a', 'b', ['me']],
      ['F_sp', 'c', 'd', ['sp']],
      ['F', 'me', 'sp', []],
    ]);
    const closed = layoutFamily(g, 'me');
    expect(node(closed, 'sp').canExpandUp).toBe(true);
    const open = layoutFamily(g, 'me', { expanded: ['sp:up'] });
    expect(describeLayout(open)).toMatchSnapshot();
    const xs = ['a', 'b', 'c', 'd'].map((k) => node(open, k).x);
    expect(xs).toEqual([...xs].sort((p, q) => p - q));
    expect(node(open, 'sp').canCollapseUp).toBe(true);
  });

  it('uses lazy-load hints for people at the edge of the slice', () => {
    const g = makeGraph({ me: 'M' }, []);
    const people = g.people as Record<string, TreePerson>;
    people['me'] = { ...people['me']!, hasMoreParents: true, hasMoreChildren: true };
    const n = layoutFamily(g, 'me').nodes[0]!;
    expect([n.canExpandUp, n.canExpandDown]).toEqual([true, true]);
  });

  it('returns an empty layout for an unknown focus person', () => {
    const layout = layoutFamily(nuclear, 'nobody');
    expect(layout.nodes).toEqual([]);
    expect(layout.focusKey).toBeNull();
    expect(layout.bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 });
  });

  it('accepts a Map of people and custom sizes', () => {
    const people = new Map(Object.entries(nuclear.people));
    const layout = layoutFamily({ people, families: nuclear.families }, 'me', {
      cardSize: { width: 96, height: 120 },
      gaps: { couple: 4, generation: 40 },
    });
    expect(node(layout, 'sp').x).toBe(100);
    expect(node(layout, 'dad').y).toBe(-160);
  });
});

describe('layoutDescendants', () => {
  it('shows the focus person, spouses and descendants only', () => {
    const layout = layoutDescendants(halfSiblings, 'dad', { descendantsDepth: 1 });
    expect(describeLayout(layout)).toMatchSnapshot();
    expect(layout.nodes.every((n) => !n.canExpandUp && !n.canCollapseUp)).toBe(true);
    expect(node(layout, 'c').canExpandDown).toBe(true);
    const deeper = layoutDescendants(halfSiblings, 'dad', {
      descendantsDepth: 1,
      expanded: ['c:down'],
    });
    expect(deeper.nodes.map((n) => n.key)).toContain('ck');
  });

  it('ignores ancestors entirely', () => {
    const layout = layoutDescendants(nuclear, 'me');
    expect(layout.nodes.some((n) => n.generation < 0)).toBe(false);
  });
});
