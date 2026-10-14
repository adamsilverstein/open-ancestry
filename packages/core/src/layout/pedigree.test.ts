import { describe, expect, it } from 'vitest';
import { layoutFan, layoutPedigree } from './index';
import {
  cousinMarriage,
  describeFan,
  describeLayout,
  makeGraph,
  threeGenerations,
} from './test-graphs';

describe('layoutPedigree', () => {
  it('lays ancestors out to the right, father above mother', () => {
    const layout = layoutPedigree(threeGenerations, 'me');
    expect(describeLayout(layout)).toMatchSnapshot();
    const n = (key: string) => layout.nodes.find((x) => x.key === key)!;
    expect([n('me').x, n('me').y]).toEqual([0, 0]);
    expect(n('dad').x).toBe(120 + 64);
    expect(n('pgf').x).toBe(2 * (120 + 64));
    expect(n('dad').y).toBeLessThan(n('mom').y);
    // The focus card is vertically centered between its parents.
    expect((n('dad').y + n('mom').y) / 2).toBe(0);
    expect(layout.labels.map((l) => [l.text, l.anchor])).toEqual([
      ['Great-grandparents', 'bottom-left'],
      ['Grandparents', 'bottom-left'],
      ['Parents', 'bottom-left'],
    ]);
    const edge = layout.edges.find((e) => e.child === 'me' && e.parents?.[0] === 'dad')!;
    expect(edge.points[0]).toEqual([120, 75]);
    expect(edge.points.at(-1)).toEqual([n('dad').x, n('dad').y + 75]);
  });

  it('stops at the depth limit and marks duplicates', () => {
    const layout = layoutPedigree(cousinMarriage, 'me', { ancestorsDepth: 3 });
    expect(layout.nodes.filter((n) => n.isDuplicate).map((n) => n.key)).toEqual(['ggf~1', 'ggm~1']);
    const shallow = layoutPedigree(cousinMarriage, 'me', { ancestorsDepth: 1 });
    expect(shallow.nodes.map((n) => n.key)).toEqual(['me', 'dad', 'mom']);
    expect(shallow.nodes.find((n) => n.key === 'dad')!.canExpandUp).toBe(true);
    expect(shallow.nodes.every((n) => !n.canExpandDown)).toBe(true);
  });

  it('handles a single known parent', () => {
    const g = makeGraph({ me: 'M', mom: 'F' }, [['F', null, 'mom', ['me']]]);
    const layout = layoutPedigree(g, 'me');
    expect(layout.nodes.find((n) => n.key === 'mom')!.y).toBe(0);
    expect(layoutPedigree(g, 'ghost').nodes).toEqual([]);
  });
});

describe('layoutFan', () => {
  it('assigns each ancestor an Ahnentafel slot in its ring', () => {
    const fan = layoutFan(threeGenerations, 'me', { generations: 4 });
    expect(describeFan(fan)).toMatchSnapshot();
    const s = (key: string) => fan.segments.find((x) => x.key === key)!;
    expect(s('me')).toMatchObject({ ahnentafel: 1, innerRadius: 0, outerRadius: 60 });
    expect(s('dad')).toMatchObject({ ahnentafel: 2, startAngle: Math.PI, endAngle: 1.5 * Math.PI });
    expect(s('mom')).toMatchObject({ ahnentafel: 3, innerRadius: 60, outerRadius: 130 });
    expect(s('mgm_m').ahnentafel).toBe(15);
    expect(fan.bounds).toEqual({
      minX: -270,
      minY: -270,
      maxX: 270,
      maxY: 0,
      width: 540,
      height: 270,
    });
  });

  it('defaults to six generations and stops there', () => {
    const fan = layoutFan(threeGenerations, 'me');
    expect(Math.max(...fan.segments.map((s) => s.generation))).toBe(3);
    expect(fan.focusKey).toBe('me');
  });

  it('marks pedigree collapse duplicates and honours collapse', () => {
    const fan = layoutFan(cousinMarriage, 'me');
    expect(fan.segments.filter((s) => s.isDuplicate).map((s) => s.duplicateOf)).toEqual([
      'ggf',
      'ggm',
    ]);
    const collapsed = layoutFan(cousinMarriage, 'me', { collapsed: ['dad:up'] });
    expect(collapsed.segments.map((s) => s.key)).toEqual([
      'me',
      'dad',
      'mom',
      'mgf',
      'mgm',
      'ggf',
      'ggm',
    ]);
  });

  it('supports a full circle and an unknown focus', () => {
    const fan = layoutFan(threeGenerations, 'me', { sweep: 2 * Math.PI, generations: 2 });
    expect(fan.bounds).toEqual({
      minX: -130,
      minY: -130,
      maxX: 130,
      maxY: 130,
      width: 260,
      height: 260,
    });
    expect(layoutFan(threeGenerations, 'ghost').segments).toEqual([]);
  });
});
