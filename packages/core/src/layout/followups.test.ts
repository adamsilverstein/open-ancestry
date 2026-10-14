/** Issue #28: half-sibling edges, lane spacing, sibling chevrons, nieces, nephews and cousins. */
import { describe, expect, it } from 'vitest';
import { layoutFamily } from './index';
import { crossings, describeLayout, makeGraph, siblings } from './test-graphs';
import type { FamilySpec } from './test-graphs';
import type { ExpandKey, LayoutNode, TreeLayout } from './types';

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
  const married = (count: number) => {
    const wives = Array.from({ length: count }, (_, i) => `w${i}`);
    const people: Record<string, 'M' | 'F'> = { dad: 'M', mom: 'F', me: 'M' };
    for (const w of wives) Object.assign(people, { [w]: 'F', [`k_${w}`]: 'M' });
    return makeGraph(people, [
      ['Fp', 'dad', 'mom', ['me']],
      ...wives.map((w): FamilySpec => [`F_${w}`, 'me', w, [`k_${w}`]]),
    ]);
  };

  it.each([3, 6, 7, 8])(
    'stay apart and clear of the cards and the bar with %i spouses',
    (count) => {
      const layout = layoutFamily(married(count), 'me');
      const barY = layout.edges.find((e) => e.child === 'me')!.points[0]![1];
      const ys = layout.edges
        .filter((e) => e.kind === 'couple' && e.points.length === 4)
        .map((e) => e.points[1]![1])
        .sort((a, b) => a - b);
      expect(ys).toHaveLength(count - 2);
      for (const y of ys) {
        expect(y).toBeLessThanOrEqual(-8);
        expect(y - barY).toBeGreaterThanOrEqual(8);
      }
      for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(8);
      // Every row moves together, and the focus card stays put.
      const rows = new Set(layout.nodes.map((n) => n.y / (n.generation || 1)));
      expect(rows.size).toBeLessThanOrEqual(2);
      expect([node(layout, 'me').x, node(layout, 'me').y]).toEqual([0, 0]);
      expect(crossings(layout.edges)).toEqual([]);
    },
  );

  it('draws small offsets as straight drops', () => {
    // Six spouses with a child each used to leave a 2-3px jog under the last couple.
    const layout = layoutFamily(married(6), 'me');
    for (const e of layout.edges.filter((x) => x.kind === 'parent-child' && x.parents)) {
      if (e.points.length === 4) {
        expect(Math.abs(e.points[2]![0] - e.points[1]![0])).toBeGreaterThanOrEqual(4);
      }
    }
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
    const drop = layout.edges.find(
      (e) => e.familyId === 'F_older' && e.kind === 'parent-child' && e.parents,
    )!;
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
    // Only the maternal side expanded: the paternal side keeps its natural place.
    const one = layoutFamily(siblings, 'me', { expanded: ['uncle:down'] });
    expect(node(one, 'cousin3').x).toBeGreaterThan(node(one, 'younger').x);
    expect(crossings(one.edges)).toEqual([]);
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

  it('keep the parents together when cousins expand', () => {
    const base = layoutFamily(siblings, 'me');
    const open = layoutFamily(siblings, 'me', { expanded: ['aunt:down', 'uncle:down'] });
    const gap = (l: TreeLayout) => node(l, 'mom').x - (node(l, 'dad').x + 120);
    // Issue #32: the couple used to be pushed 400+px apart to make room.
    expect(gap(open)).toBe(gap(base));
    expect(node(open, 'dad').x).toBe(node(base, 'dad').x);
    // The cousins slide out past the focus row instead, still under their own side.
    expect(node(open, 'cousin2').x + 120).toBeLessThan(node(open, 'half').x);
    expect(node(open, 'cousin3').x).toBeGreaterThan(node(open, 'younger').x + 120);
    expect(crossings(open.edges)).toEqual([]);
  });

  it("stop at cousins: great-aunts and a spouse's aunts get no chevron", () => {
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
        sp: 'F',
        sdad: 'M',
        smom: 'F',
        saunt: 'F',
        sc: 'M',
      },
      [
        ['F1', 'dad', 'mom', ['me']],
        ['F2', 'gpa', 'gma', ['dad']],
        ['F3', 'ggpa', 'ggma', ['gaunt', 'gpa']],
        ['F4', 'gaunt', null, ['pc']],
        ['F5', 'me', 'sp', []],
        ['F6', 'sdad', 'smom', ['sp']],
        ['F7', 'gpa2', null, ['saunt', 'sdad']],
        ['F8', 'saunt', null, ['sc']],
      ],
    );
    const layout = layoutFamily(g, 'me', {
      siblingsDepth: 3,
      expanded: ['gaunt:down', 'sp:up', 'sdad:siblings', 'saunt:down'],
    });
    expect(node(layout, 'gaunt').canExpandDown).toBe(false);
    expect(keys(layout)).not.toContain('pc');
    expect(keys(layout)).not.toContain('sc');
    expect(crossings(layout.edges)).toEqual([]);
  });

  it("keep a lone parent's siblings and cousins on one side", () => {
    const g = makeGraph({ me: 'M', mom: 'F', gma: 'F', aunt: 'F', uncle: 'M', c1: 'M', c2: 'F' }, [
      ['F1', null, 'mom', ['me']],
      ['F2', null, 'gma', ['aunt', 'mom', 'uncle']],
      ['F3', 'aunt', null, ['c1']],
      ['F4', 'uncle', null, ['c2']],
    ]);
    const layout = layoutFamily(g, 'me', { expanded: ['aunt:down', 'uncle:down'] });
    const row = layout.nodes
      .filter((n) => n.generation === -1)
      .sort((a, b) => a.x - b.x)
      .map((n) => n.key);
    expect(row).toEqual(['mom', 'aunt', 'uncle']);
    expect(node(layout, 'c1').x).toBeGreaterThan(0);
    expect(crossings(layout.edges)).toEqual([]);
    // A lone father's siblings and their children go on his left.
    const g2 = makeGraph({ me: 'M', dad: 'M', gpa: 'M', uncle: 'M', c: 'F' }, [
      ['F1', 'dad', null, ['me']],
      ['F2', 'gpa', null, ['dad', 'uncle']],
      ['F3', 'uncle', null, ['c']],
    ]);
    const left = layoutFamily(g2, 'me', { expanded: ['uncle:down'] });
    expect(node(left, 'uncle').x).toBeLessThan(node(left, 'dad').x);
    expect(node(left, 'c').x).toBeLessThan(0);
    expect(crossings(left.edges)).toEqual([]);
  });
});

describe('connector band', () => {
  it('keeps jogging connectors at least 8px apart when many families share a row', () => {
    // A grandmother with ten married children (the father and nine aunts and
    // uncles), each with three children: every family's connector jogs out.
    const people: Record<string, 'M' | 'F'> = { gpa: 'M', gma: 'F', me: 'M', mom: 'F' };
    const fams: FamilySpec[] = [];
    const kids = ['dad', ...Array.from({ length: 9 }, (_, i) => `aunt${i}`)];
    fams.push(['Fg', 'gpa', 'gma', kids]);
    for (const [i, kid] of kids.entries()) {
      people[kid] = i === 0 ? 'M' : 'F';
      if (i === 0) continue;
      people[`${kid}h`] = 'M';
      const cousins = [0, 1, 2].map((j) => `${kid}c${j}`);
      for (const c of cousins) people[c] = 'M';
      fams.push([`F_${kid}`, `${kid}h`, kid, cousins]);
    }
    fams.push(['Fme', 'dad', 'mom', ['me']]);
    const g = makeGraph(people, fams);
    const layout = layoutFamily(g, 'me', {
      siblingsDepth: 3,
      expanded: kids.slice(1).map((k): ExpandKey => `${k}:down`),
    });
    expect(crossings(layout.edges)).toEqual([]);
    // Horizontal jog levels of the drops into the focus row.
    const levels = [
      ...new Set(
        layout.edges
          .filter((e) => e.kind === 'parent-child' && e.parents && e.points.length === 4)
          .filter((e) => e.points.at(-1)![1] < 0 && e.points.at(-1)![1] > -64 - 150)
          .map((e) => e.points[1]![1]),
      ),
    ].sort((a, b) => a - b);
    expect(levels.length).toBeGreaterThan(4);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!).toBeGreaterThanOrEqual(8);
    }
    expect([node(layout, 'me').x, node(layout, 'me').y]).toEqual([0, 0]);
  });
});
