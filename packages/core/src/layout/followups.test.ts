/** Issue #28: half-sibling edges, lane spacing, sibling chevrons, nieces, nephews and cousins. */
import { describe, expect, it } from 'vitest';
import { layoutFamily } from './index';
import { crossings, describeLayout, makeGraph, siblings } from './test-graphs';
import type { LayoutNode, TreeLayout } from './types';

const node = (layout: TreeLayout, key: string): LayoutNode => {
  const found = layout.nodes.find((n) => n.key === key);
  if (!found) throw new Error(`no node ${key}`);
  return found;
};
const centerX = (n: LayoutNode) => n.x + n.width / 2;
const keys = (layout: TreeLayout) => layout.nodes.map((n) => n.key);

describe('half siblings', () => {
  it('hang from the shared parent only, with their own family id', () => {
    const layout = layoutFamily(siblings, 'me');
    const edges = layout.edges.filter((e) => e.familyId === 'F_step');
    const drop = edges.find((e) => e.parents)!;
    const dad = node(layout, 'dad');
    expect(drop.parents).toEqual(['dad']);
    expect(drop.points[0]).toEqual([centerX(dad), dad.y + dad.height]);
    const into = edges.find((e) => e.child === 'half')!;
    expect(into).toMatchObject({ half: true, sharedParentId: 'dad', familyId: 'F_step' });
    expect(into.points.at(-1)).toEqual([centerX(node(layout, 'half')), 0]);
    // Nothing for the half brother is drawn under the parents' own family.
    expect(layout.edges.some((e) => e.familyId === 'F_me' && e.child === 'half')).toBe(false);
    expect(crossings(layout.edges)).toEqual([]);
  });

  it('keep their family and shared parent when the parents are hidden', () => {
    const layout = layoutFamily(siblings, 'me', { ancestorsDepth: 0 });
    const into = layout.edges.find((e) => e.child === 'half')!;
    expect(into).toMatchObject({ familyId: 'F_step', sharedParentId: 'dad', half: true });
  });

  it('go on the mother side for a maternal half sibling', () => {
    const g = makeGraph({ dad: 'M', mom: 'F', other: 'M', me: 'M', mhalf: 'F' }, [
      ['F', 'dad', 'mom', ['me']],
      ['F2', 'other', 'mom', ['mhalf']],
    ]);
    const layout = layoutFamily(g, 'me');
    expect(node(layout, 'mhalf').x).toBeGreaterThan(0);
    expect(layout.edges.find((e) => e.familyId === 'F2' && e.parents)?.parents).toEqual(['mom']);
    expect(crossings(layout.edges)).toEqual([]);
  });
});

describe('spouse lanes', () => {
  it('keep clear of the card tops and the sibling bar above', () => {
    const wives = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
    const g = makeGraph(
      { dad: 'M', mom: 'F', me: 'M', ...Object.fromEntries(wives.map((w) => [w, 'F' as const])) },
      [
        ['Fp', 'dad', 'mom', ['me']],
        ...wives.map((w): [string, string, string, string[]] => [`F_${w}`, 'me', w, []]),
      ],
    );
    const layout = layoutFamily(g, 'me');
    const barY = layout.edges.find((e) => e.kind === 'sibling-bar' || e.child === 'me')!
      .points[0]![1];
    const lanes = layout.edges.filter((e) => e.kind === 'couple' && e.points.length === 4);
    expect(lanes).toHaveLength(4);
    for (const lane of lanes) {
      const y = lane.points[1]![1];
      expect(y).toBeLessThanOrEqual(-8);
      expect(y - barY).toBeGreaterThanOrEqual(8);
    }
    expect(crossings(layout.edges)).toEqual([]);
  });
});

describe('sibling chevrons', () => {
  it('let siblings, aunts and uncles expand their own children', () => {
    const layout = layoutFamily(siblings, 'me');
    expect(node(layout, 'older')).toMatchObject({ canExpandDown: true, canCollapseDown: false });
    expect(node(layout, 'aunt').canExpandDown).toBe(true);
    expect(node(layout, 'uncle').canExpandDown).toBe(true);
    expect(node(layout, 'younger').canExpandDown).toBe(false);
    // Spouses of siblings get none.
    expect(node(layout, 'olderW').canExpandDown).toBe(false);
    expect(keys(layout)).not.toContain('niece');
    expect(keys(layout)).not.toContain('cousin1');
  });

  it('show nieces and nephews in the children row', () => {
    const layout = layoutFamily(siblings, 'me', { expanded: ['older:down'] });
    expect(describeLayout(layout)).toMatchSnapshot();
    const niece = node(layout, 'niece');
    expect(niece.generation).toBe(1);
    expect(node(layout, 'older').canCollapseDown).toBe(true);
    // Under her parents' couple, left of the focus person's child.
    const older = node(layout, 'older');
    const olderW = node(layout, 'olderW');
    expect(niece.x).toBeLessThan(node(layout, 'kid').x);
    const drop = layout.edges.find((e) => e.familyId === 'F_older' && e.parents)!;
    expect(drop.points[0]).toEqual([(older.x + older.width + olderW.x) / 2, older.height / 2]);
    expect([node(layout, 'me').x, node(layout, 'me').y]).toEqual([0, 0]);
    expect(crossings(layout.edges)).toEqual([]);
  });

  it('show cousins in the focus row under their parents', () => {
    const layout = layoutFamily(siblings, 'me', { expanded: ['aunt:down', 'uncle:down'] });
    expect(describeLayout(layout)).toMatchSnapshot();
    const row = layout.nodes
      .filter((n) => n.generation === 0)
      .sort((a, b) => a.x - b.x)
      .map((n) => n.key);
    expect(row).toEqual([
      'cousin1',
      'cousin2',
      'half',
      'older',
      'olderW',
      'sp',
      'me',
      'younger',
      'cousin3',
    ]);
    expect(node(layout, 'aunt').canCollapseDown).toBe(true);
    // Cousins sit on the edge of the slice: no further chevrons below the focus row.
    expect(node(layout, 'cousin1').canExpandDown).toBe(false);
    expect([node(layout, 'me').x, node(layout, 'me').y]).toEqual([0, 0]);
    expect(crossings(layout.edges)).toEqual([]);
    const sorted = [...layout.nodes].sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      const [a, b] = [sorted[i - 1]!, sorted[i]!];
      if (a.y === b.y) expect(b.x - (a.x + a.width)).toBeGreaterThanOrEqual(16);
    }
  });

  it('show the children of great-aunts and great-uncles a row up', () => {
    const g = makeGraph(
      {
        me: 'M',
        dad: 'M',
        mom: 'F',
        gpa: 'M',
        gma: 'F',
        ggpa: 'M',
        ggma: 'F',
        gaunt: 'F',
        pc: 'M',
      },
      [
        ['F1', 'dad', 'mom', ['me']],
        ['F2', 'gpa', 'gma', ['dad']],
        ['F3', 'ggpa', 'ggma', ['gaunt', 'gpa']],
        ['F4', 'gaunt', null, ['pc']],
      ],
    );
    const layout = layoutFamily(g, 'me', { siblingsDepth: 3, expanded: ['gaunt:down'] });
    expect(node(layout, 'pc').generation).toBe(-1);
    expect(node(layout, 'pc').x + 120).toBeLessThanOrEqual(node(layout, 'dad').x);
    expect(crossings(layout.edges)).toEqual([]);
  });
});
