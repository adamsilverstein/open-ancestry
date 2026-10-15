import { describe, expect, it } from 'vitest';
import { kinshipGraph, relationship } from '@open-ancestry/core';
import type { ChildRelation, TreeFamily, TreeGraph } from '@open-ancestry/core';
import type { ApiPersonSummary, RelationshipView } from '../api/types';
import { relationshipCharts } from './relationship';

/** A tiny graph: families as [id, partner1, partner2, children (id or [id, rel])]. */
function graph(
  sexes: Record<string, 'M' | 'F'>,
  families: [string, string | null, string | null, (string | [string, ChildRelation])[]][],
): TreeGraph {
  return {
    people: Object.fromEntries(
      Object.entries(sexes).map(([id, sex]) => [id, { id, sex, name: id, living: false }]),
    ),
    families: families.map(([id, p1, p2, kids]): TreeFamily => ({
      id,
      partners: [p1, p2],
      children: kids.map((k) =>
        typeof k === 'string' ? { id: k } : { id: k[0], rel1: k[1], rel2: k[1] },
      ),
    })),
  };
}

/** What the server returns: the core result plus a summary per person. */
function view(g: TreeGraph, a: string, b: string): RelationshipView {
  const result = relationship(kinshipGraph(g), a, b);
  const people = Object.values(g.people as Record<string, { id: string; sex: string }>).map(
    (p) =>
      ({
        id: p.id,
        sex: p.sex,
        given: p.id[0]!.toUpperCase() + p.id.slice(1),
        surname: 'Ashgrove',
        living: 'dead',
      }) as unknown as ApiPersonSummary,
  );
  return { ...result, people };
}

/*
 * Thaddeus's children Josiah and Clementine; Josiah's grandson married
 * Clementine's granddaughter, so their daughter Lily descends from Thaddeus
 * through both.
 */
const collapse = graph(
  {
    thaddeus: 'M',
    mercy: 'F',
    josiah: 'M',
    clementine: 'F',
    jkid: 'M',
    ckid: 'F',
    walter: 'M',
    mabel: 'F',
    lily: 'F',
  },
  [
    ['F1', 'thaddeus', 'mercy', ['josiah', 'clementine']],
    ['F2', 'josiah', null, ['jkid']],
    ['F3', null, 'clementine', ['ckid']],
    ['F4', 'jkid', null, ['walter']],
    ['F5', null, 'ckid', ['mabel']],
    ['F6', 'walter', 'mabel', ['lily']],
  ],
);

describe('relationshipCharts', () => {
  it('labels collapsed paths by the line they take, not "line N"', () => {
    const { name, charts } = relationshipCharts(view(collapse, 'lily', 'thaddeus'));
    expect(name).toBe('2nd great-granddaughter');
    expect(charts.map((c) => c.label)).toEqual([
      '2nd great-granddaughter through Josiah Ashgrove',
      '2nd great-granddaughter through Clementine Ashgrove',
    ]);
  });

  it('never says "through" one of the two people', () => {
    const { charts } = relationshipCharts(view(collapse, 'thaddeus', 'lily'));
    expect(charts.map((c) => c.label)).toEqual([
      '2nd great-grandfather through Josiah Ashgrove',
      '2nd great-grandfather through Clementine Ashgrove',
    ]);
    const single = relationshipCharts(view(collapse, 'josiah', 'thaddeus')).charts;
    expect(single.map((c) => c.label)).toEqual(['son']);
  });

  it('names a single blood path by its common ancestor', () => {
    const { charts } = relationshipCharts(view(collapse, 'jkid', 'ckid'));
    expect(charts.map((c) => c.label)).toEqual(['1st cousin through Thaddeus Ashgrove']);
    expect(charts[0]!.cells.map((c) => c.role)).toEqual([
      'person',
      'between',
      'common-ancestor',
      'between',
      'home',
    ]);
  });

  it('keeps step and adoptive links on the chart cells', () => {
    const g = graph({ leopold: 'M', edith: 'F', george: 'M', peter: 'M' }, [
      ['F7', 'leopold', 'edith', [['george', 'step']]],
      ['F8', 'leopold', null, [['peter', 'adopted']]],
    ]);
    const step = relationshipCharts(view(g, 'leopold', 'george')).charts[0]!.cells;
    expect(step.map((c) => [c.step, c.rel])).toEqual([
      [undefined, undefined],
      ['child', 'step'],
    ]);
  });

  it('gives no name or chart when unrelated', () => {
    const g = graph({ a: 'M', b: 'F' }, []);
    expect(relationshipCharts(view(g, 'a', 'b'))).toEqual({ name: null, charts: [] });
  });
});
