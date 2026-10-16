/**
 * Tree card labels vs the relationship calculator, which the
 * core kin module says must never call the same two people different things.
 */
import { describe, expect, it } from 'vitest';
import {
  kinshipGraph,
  layoutFamily,
  relationship,
  type ChildRelation,
  type TreeGraph,
  type TreePerson,
} from '@open-ancestry/core';
import { buildRelations, kinshipLabels } from './relations';

type Spec = [string, string | null, string | null, (string | [string, ChildRelation])[]];
const mk = (people: Record<string, 'M' | 'F'>, fams: Spec[]): TreeGraph => ({
  people: Object.fromEntries(
    Object.entries(people).map(([id, sex]) => [
      id,
      { id, sex, name: id, living: false } as TreePerson,
    ]),
  ),
  families: fams.map(([id, a, b, kids]) => ({
    id,
    partners: [a, b],
    children: kids.map((k) =>
      typeof k === 'string' ? { id: k } : { id: k[0], rel1: k[1], rel2: k[1] },
    ),
  })),
});
const labels = (g: TreeGraph, focus: string, opts = {}) => {
  const l = layoutFamily(g, focus, opts);
  const sex = (k: string) => (g.people as Record<string, TreePerson>)[k.split('~')[0]!]!.sex as 'M';
  return kinshipLabels(buildRelations(l, g), l.focusKey!, sex);
};
/** What `a` is to `b`, per the calculator. */
const calc = (g: TreeGraph, a: string, b: string) => relationship(kinshipGraph(g), a, b).name;

describe('tree card kinship labels agree with the calculator', () => {
  const guarded = mk({ me: 'M', gd: 'M', gdw: 'F', bk: 'F', kid: 'M' }, [
    ['Fg', 'gd', 'gdw', [['me', 'guardian'], 'bk']],
    ['Fk', 'me', null, [['kid', 'guardian']]],
  ]);

  it('does not call a guardian "father"', () => {
    expect(calc(guarded, 'gd', 'me')).toBe('guardian');
    expect(labels(guarded, 'me').gd).toBe(calc(guarded, 'gd', 'me'));
  });

  it('does not call a ward "son"', () => {
    expect(calc(guarded, 'kid', 'me')).toBe('ward');
    expect(labels(guarded, 'me').kid).toBe(calc(guarded, 'kid', 'me'));
  });

  it("does not call the guardian's birth child a plain sister", () => {
    expect(calc(guarded, 'bk', 'me')).toBe('foster sister');
    expect(labels(guarded, 'me').bk).toBe(calc(guarded, 'bk', 'me'));
  });

  it('does not call a relative raising the child ("related") "father"', () => {
    const g = mk({ me: 'M', un: 'M' }, [['F', 'un', null, [['me', 'related']]]]);
    expect(labels(g, 'me').un).toBe(calc(g, 'un', 'me'));
  });

  it("names a sibling's adopted son an adopted nephew, not adoptive", () => {
    const g = mk({ d: 'M', m: 'F', me: 'M', sis: 'F', nep: 'M' }, [
      ['Fme', 'd', 'm', ['me', 'sis']],
      ['Fsis', null, 'sis', [['nep', 'adopted']]],
    ]);
    expect(calc(g, 'nep', 'me')).toBe('adopted nephew');
    expect(labels(g, 'me', { expanded: ['sis:down'] }).nep).toBe('adopted nephew');
  });

  it("names an aunt's adopted son an adopted cousin, not adoptive", () => {
    const g = mk({ g: 'M', gm: 'F', d: 'M', me: 'M', au: 'F', cou: 'M' }, [
      ['Fd', 'g', 'gm', ['d', 'au']],
      ['Fme', 'd', null, ['me']],
      ['Fau', null, 'au', [['cou', 'adopted']]],
    ]);
    expect(labels(g, 'me', { expanded: ['au:down'] }).cou).toMatch(/^adopted /);
  });
});

describe('deep lines', () => {
  it('names a 3rd great-grandfather and a 3rd great-grandson when shown', () => {
    const people: Record<string, 'M' | 'F'> = {};
    const fams: Spec[] = [];
    for (let i = -6; i <= 6; i++) people[`p${i}`] = 'M';
    // p(i+1) is the father of p(i): p6 is the top ancestor, p-6 the last descendant.
    for (let i = -6; i < 6; i++) fams.push([`f${i}`, `p${i + 1}`, null, [`p${i}`]]);
    const g = mk(people, fams);
    const k = labels(g, 'p0', { ancestorsDepth: 6, descendantsDepth: 6 });
    expect(k.p4).toBe('2nd great-grandfather');
    expect(k.p5).toBe('3rd great-grandfather');
    expect(k['p-5']).toBe('3rd great-grandson');
  });
});

describe('adopted child and an adoptive parent’s other children', () => {
  it("names the adoptive father's son by another partner as the calculator does, not half-brother", () => {
    const g = mk({ p: 'M', q: 'F', r: 'F', me: 'M', y: 'M' }, [
      ['F', 'p', 'q', [['me', 'adopted']]],
      ['G', 'p', 'r', ['y']],
    ]);
    const calcName = calc(g, 'y', 'me');
    expect(calcName).toBe('adopted brother');
    expect(labels(g, 'me').y).toBe(calcName);
  });
});

describe('spouse of a half-aunt', () => {
  it("does not call a half-aunt's husband a half-uncle", () => {
    const g = mk({ gf: 'M', gm: 'F', gm2: 'F', d: 'M', me: 'M', au: 'F', auh: 'M' }, [
      ['Fd', 'gf', 'gm', ['d']],
      ['Fau', 'gf', 'gm2', ['au']],
      ['Fme', 'd', null, ['me']],
      ['Fauh', 'auh', 'au', []],
    ]);
    const k = labels(g, 'me');
    expect(k.au).toBe('half-aunt');
    // No blood tie, so no "half": the calculator says "husband of half-aunt".
    expect(calc(g, 'auh', 'me')).not.toMatch(/half-uncle/);
    expect(k.auh).not.toBe('half-uncle');
  });
});

describe('adoption on the focus side of an uncle (#296 review)', () => {
  it('names the uncle an adoptive uncle when the focus person’s father was adopted', () => {
    // p22 adopted p41 (his wife p40 is p41's birth mother); p37 is p22's birth
    // son by another wife. p37 was never adopted: he is p76's adoptive uncle.
    const g = mk({ p22: 'M', p40: 'F', p36: 'F', p41: 'M', p37: 'M', p76: 'M' }, [
      ['f12', 'p22', 'p40', [['p41', 'adopted']]],
      ['f11', 'p22', 'p36', ['p37']],
      ['f20', 'p41', null, ['p76']],
    ]);
    // Only p41's link to p22 is an adoption.
    (g.families[0]!.children[0] as { rel2?: ChildRelation }).rel2 = 'biological';
    expect(calc(g, 'p37', 'p76')).toBe('adoptive uncle');
    expect(labels(g, 'p76').p37).toBe('adoptive uncle');
  });
});
