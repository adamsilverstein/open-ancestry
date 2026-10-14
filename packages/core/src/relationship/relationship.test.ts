import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fromNeighborhood } from '../layout';
import { chartPath, kinshipGraph, relationship, relationshipName } from './index';
import type { KinshipGraph } from './index';
import {
  bigFamily,
  collapse,
  cousinParents,
  doubleCousins,
  GraphBuilder,
  randomTree,
} from './test-family';

const family = kinshipGraph(bigFamily());
const name = (g: KinshipGraph, a: string, b: string) => relationship(g, a, b).name;

describe('relationship names (A is B’s ...)', () => {
  // [A, B, Ancestry-style name, formal name when it differs]
  it.each<[string, string, string, string?]>([
    // Self and unrelated
    ['me', 'me', 'self'],
    ['stranger', 'me', 'unrelated'],
    ['me', 'stranger', 'unrelated'],
    // Direct line up
    ['dad', 'me', 'father'],
    ['mom', 'me', 'mother'],
    ['gf', 'me', 'grandfather'],
    ['gm', 'me', 'grandmother'],
    ['ggf', 'me', 'great-grandfather'],
    ['gggf', 'me', '2nd great-grandfather'],
    ['gggm', 'me', '2nd great-grandmother'],
    ['me', 'g4son', '3rd great-grandmother'],
    ['bro', 'kidU', 'father'],
    // Direct line down
    ['me', 'dad', 'daughter'],
    ['bro', 'dad', 'son'],
    ['me', 'gf', 'granddaughter'],
    ['me', 'ggf', 'great-granddaughter'],
    ['gggson', 'me', '2nd great-grandson'],
    ['g4son', 'me', '3rd great-grandson'],
    ['kidU', 'bro', 'child'],
    // Siblings and half siblings
    ['bro', 'me', 'brother'],
    ['sis', 'me', 'sister'],
    ['me', 'bro', 'sister'],
    ['halfbro', 'me', 'half-brother'],
    ['me', 'halfbro', 'half-sister'],
    ['halfsis', 'me', 'half-sister'],
    ['dadStep', 'me', 'half-brother'],
    // Aunts, uncles, nieces, nephews
    ['uncle', 'me', 'uncle'],
    ['aunt', 'me', 'aunt'],
    ['me', 'uncle', 'niece'],
    ['bro', 'aunt', 'nephew'],
    ['gaunt', 'me', 'grandaunt', 'great-aunt'],
    ['gaunt', 'dad', 'aunt'],
    ['ggUncle', 'me', 'great-granduncle'],
    ['nephew', 'me', 'nephew'],
    ['niece', 'me', 'niece'],
    ['gnephew', 'me', 'grandniece', 'great-niece'],
    ['me', 'gnephew', 'grandaunt', 'great-aunt'],
    ['halfnephew', 'me', 'half-nephew'],
    ['kidU', 'me', 'niece or nephew'],
    ['me', 'kidU', 'aunt'],
    // Cousins
    ['cousin1', 'me', '1st cousin'],
    ['cousin2', 'me', '1st cousin'],
    ['cousin3', 'me', '1st cousin'],
    ['gcousin', 'me', '1st cousin 1x removed', '1st cousin once removed'],
    ['me', 'gcousin', '1st cousin 1x removed', '1st cousin once removed'],
    ['gc2', 'me', '2nd cousin'],
    ['gc3', 'me', '2nd cousin 1x removed', '2nd cousin once removed'],
    ['c1kid', 'me', '1st cousin 1x removed', '1st cousin once removed'],
    ['c1gkid', 'me', '1st cousin 2x removed', '1st cousin twice removed'],
    ['ggUcousin', 'me', '1st cousin 2x removed', '1st cousin twice removed'],
    ['cousin1', 'son', '1st cousin 1x removed', '1st cousin once removed'],
    ['gc3', 'son', '3rd cousin'],
    ['gc3', 'gson', '3rd cousin 1x removed', '3rd cousin once removed'],
    ['gc2', 'son', '2nd cousin 1x removed', '2nd cousin once removed'],
    ['ggUcousin', 'son', '1st cousin 3x removed', '1st cousin 3 times removed'],
    // Adoption, foster and step edges
    ['adoptee', 'me', 'adopted son'],
    ['me', 'adoptee', 'adoptive mother'],
    ['adoptee', 'son', 'adopted brother'],
    ['son', 'adoptee', 'adoptive brother'],
    ['adoptee', 'dad', 'adopted grandson'],
    ['fosterkid', 'uncle', 'foster daughter'],
    ['uncle', 'fosterkid', 'foster father'],
    ['dad', 'dadStep', 'stepfather'],
    ['dadStep', 'dad', 'stepson'],
    // Marriage
    ['hus', 'me', 'husband'],
    ['me', 'hus', 'wife'],
    ['husDad', 'me', 'father-in-law'],
    ['husMom', 'me', 'mother-in-law'],
    ['me', 'husDad', 'daughter-in-law'],
    ['husSis', 'me', 'sister-in-law'],
    ['broW', 'me', 'sister-in-law'],
    ['me', 'broW', 'sister-in-law'],
    ['hus', 'bro', 'brother-in-law'],
    ['sonW', 'me', 'daughter-in-law'],
    ['me', 'sonW', 'mother-in-law'],
    ['hus', 'dad', 'son-in-law'],
    ['stepmom', 'me', 'stepmother'],
    ['me', 'stepmom', 'stepdaughter'],
    ['stepdau', 'me', 'stepdaughter'],
    ['me', 'stepdau', 'stepmother'],
    ['stepsib', 'me', 'stepbrother'],
    ['stepmom', 'son', 'step-grandmother'],
    ['uncleW', 'me', 'wife of uncle', 'aunt by marriage'],
    ['auntH', 'me', 'husband of aunt', 'uncle by marriage'],
    ['sisH', 'bro', 'brother-in-law'],
    ['c1w', 'me', 'wife of 1st cousin', '1st cousin’s wife'],
    ['cousin1', 'hus', '1st cousin of wife', 'wife’s 1st cousin'],
    ['husSisH', 'me', 'husband of sister-in-law', 'sister-in-law’s husband'],
    ['me', 'uncleW', 'niece of husband', 'niece by marriage'],
    ['gson', 'hus', 'grandson'],
    ['dadStep', 'gf', 'step-grandson'],
    ['fosterkid', 'cousin1', 'foster sister'],
    ['halfnephew', 'nephew', 'half 1st cousin'],
    ['gaunt', 'son', 'great-grandaunt'],
    ['ggUncle', 'son', '2nd great-granduncle'],
    ['son', 'gaunt', 'great-grandnephew'],
    ['gson', 'gaunt', '2nd great-grandnephew'],
  ])('%s is %s’s %s', (a, b, ancestry, formal = ancestry) => {
    expect(name(family, a, b)).toBe(ancestry);
    expect(relationship(family, a, b, { style: 'formal' }).name).toBe(formal);
  });
});

describe('paths and pedigree collapse', () => {
  it('returns the path from A up to the common ancestors and down to B', () => {
    const r = relationship(family, 'cousin1', 'me');
    expect(r.relationships).toHaveLength(1);
    expect(r.complete).toBe(true);
    const [first] = r.relationships;
    expect(first).toMatchObject({
      kind: 'blood',
      half: false,
      generations: [2, 2],
      commonAncestors: ['gf', 'gm'],
    });
    expect(first!.paths[0]).toEqual({
      ids: ['cousin1', 'uncle', 'gf', 'dad', 'me'],
      steps: [
        { kind: 'parent', rel: 'unknown' },
        { kind: 'parent', rel: 'unknown' },
        { kind: 'child', rel: 'unknown' },
        { kind: 'child', rel: 'unknown' },
      ],
      generations: [2, 2],
    });
  });

  it('marks half relationships with a single common ancestor', () => {
    const r = relationship(family, 'halfbro', 'me').relationships[0]!;
    expect(r).toMatchObject({ half: true, commonAncestors: ['dad'] });
  });

  it('reports a marriage path with its spouse steps', () => {
    const r = relationship(family, 'stepmom', 'me').relationships[0]!;
    expect(r.kind).toBe('marriage');
    expect(r.paths[0]).toEqual({
      ids: ['stepmom', 'dad', 'me'],
      steps: [{ kind: 'spouse' }, { kind: 'child', rel: 'unknown' }],
    });
  });

  it('names both relationships when pedigree collapse gives two', () => {
    const g = kinshipGraph(collapse());
    const r = relationship(g, 'A', 'B');
    expect(r.name).toBe('2nd cousin and also 3rd cousin 1x removed');
    expect(r.relationships.map((x) => x.commonAncestors)).toEqual([
      ['p1', 'p2'],
      ['q1', 'q2'],
    ]);
    expect(relationship(g, 'B', 'A', { style: 'formal' }).name).toBe(
      '2nd cousin and also 3rd cousin once removed',
    );
  });

  it('collects every path for one name when parents are cousins', () => {
    const g = kinshipGraph(cousinParents());
    const r = relationship(g, 'ggf', 'me');
    expect(r.name).toBe('great-grandfather');
    expect(r.relationships).toHaveLength(1);
    expect(r.relationships[0]!.paths.map((p) => p.ids)).toEqual([
      ['ggf', 'ga', 'dad', 'me'],
      ['ggf', 'gb', 'mom', 'me'],
    ]);
    expect(name(g, 'dad', 'mom')).toBe('husband and also 1st cousin');
  });

  it('calls two cousin relationships through both parents double cousins', () => {
    const g = kinshipGraph(doubleCousins());
    const r = relationship(g, 'k1', 'k2');
    expect(r.name).toBe('double 1st cousin');
    expect(r.relationships[0]!.paths).toHaveLength(2);
  });

  it('uses neutral words for an unknown sex and unknown ids', () => {
    const g = kinshipGraph(
      new GraphBuilder()
        .person('p', 'X')
        .person('c', 'U')
        .person('d', 'U')
        .family('F', 'p', null, ['c', 'd'])
        .build(),
    );
    expect(name(g, 'p', 'c')).toBe('parent');
    expect(name(g, 'c', 'd')).toBe('sibling');
    expect(name(g, 'ghost', 'c')).toBe('unrelated');
  });

  it('terminates on cycles and respects the generation bound', () => {
    const g = kinshipGraph(
      new GraphBuilder()
        .person('a', 'M')
        .person('b', 'F')
        .family('F1', 'a', null, ['b'])
        .family('F2', 'b', null, ['a'])
        .build(),
    );
    expect(name(g, 'a', 'b')).toBe('father and also son');
    const chain = new GraphBuilder();
    for (let i = 0; i <= 30; i++) chain.person(`p${i}`, 'M');
    for (let i = 0; i < 30; i++) chain.family(`f${i}`, `p${i + 1}`, null, [`p${i}`]);
    const deep = kinshipGraph(chain.build());
    expect(name(deep, 'p25', 'p0')).toBe('unrelated');
    expect(relationship(deep, 'p25', 'p0', { maxGenerations: 30 }).name).toBe(
      '23rd great-grandfather',
    );
    expect(name(deep, 'p13', 'p0')).toBe('11th great-grandfather');
    expect(name(deep, 'p0', 'p4')).toBe('2nd great-grandson');
  });

  it('is symmetric in whether people are related, and terminates on random trees', () => {
    const { graph, ids } = randomTree(400, 3);
    const g = kinshipGraph(graph);
    fc.assert(
      fc.property(fc.constantFrom(...ids), fc.constantFrom(...ids), (a, b) => {
        const ab = relationship(g, a, b);
        const ba = relationship(g, b, a);
        expect(ab.relationships.length > 0).toBe(ba.relationships.length > 0);
        for (const r of ab.relationships) {
          for (const p of r.paths) {
            expect(p.ids[0]).toBe(a);
            expect(p.ids.at(-1)).toBe(b);
            expect(p.steps).toHaveLength(p.ids.length - 1);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('marriage chains', () => {
  const g = kinshipGraph(
    new GraphBuilder()
      .person('a', 'M')
      .person('b', 'F')
      .person('bro', 'M')
      .person('broW', 'F')
      .person('broWsis', 'F')
      .person('wp', 'M')
      .person('x', 'F')
      .person('kid', 'M')
      .person('other', 'M')
      .person('p', 'M')
      .person('q', 'F')
      .family('F_p', 'p', 'q', ['bro', 'b'])
      .family('F_bro', 'bro', 'broW', [])
      .family('F_w', 'wp', null, ['broW', 'broWsis'])
      .family('F_x', 'a', 'x', [])
      .family('F_kid', null, 'x', ['kid'])
      .family('F_other', 'other', null, ['kid'])
      .build(),
  );

  it('names longer marriage paths as a chain', () => {
    const formal = (a: string, b: string) => relationship(g, a, b, { style: 'formal' }).name;
    expect(name(g, 'broWsis', 'b')).toBe('sister of wife of brother');
    expect(formal('broWsis', 'b')).toBe('brother’s wife’s sister');
    // x's son by a different, unpartnered father.
    expect(name(g, 'a', 'other')).toBe('husband of mother of son');
    expect(formal('a', 'other')).toBe('son’s mother’s husband');
  });

  it('calls unmarried partners partners and respects the depth bound', () => {
    const partners = kinshipGraph({
      people: {
        a: { id: 'a', sex: 'F', name: 'a', living: false },
        b: { id: 'b', sex: 'F', name: 'b', living: false },
      },
      families: [{ id: 'F', partners: ['a', 'b'], children: [], relationship: 'partners' }],
    });
    expect(name(partners, 'a', 'b')).toBe('partner');
    expect(relationship(g, 'broWsis', 'b', { maxGenerations: 0 }).name).toBe('unrelated');
    expect(relationship(g, 'broWsis', 'b', { maxNodes: 3 }).name).toBe('unrelated');
  });
});

describe('relationshipName and neighborhood input', () => {
  it('names a shape directly for callers with their own walk', () => {
    expect(relationshipName({ up: 2, down: 3 }, 'M')).toBe('1st cousin 1x removed');
    expect(relationshipName({ up: 0, down: 5 }, 'F')).toBe('3rd great-grandmother');
    expect(relationshipName({ up: 1, down: 1 }, 'F', true)).toBe('half-sister');
    expect(relationshipName({ up: 1, down: 3 }, 'M')).toBe('granduncle');
    const formal = (up: number, down: number, half = false) =>
      relationshipName({ up, down }, 'F', half, undefined, 'formal');
    expect([formal(2, 3), formal(1, 1, true), formal(1, 3)]).toEqual([
      '1st cousin once removed',
      'half-sister',
      'great-aunt',
    ]);
  });

  it('runs over a db neighborhood DTO', () => {
    const person = (id: string, sex: 'M' | 'F') => ({
      id,
      sex,
      living: 'dead',
      given: id,
      surname: null,
      birth: null,
      death: null,
    });
    const graph = kinshipGraph(
      fromNeighborhood({
        people: [person('dad', 'M'), person('me', 'F'), person('sis', 'F')],
        families: [
          {
            id: 'F',
            partner1Id: 'dad',
            partner2Id: null,
            relationshipType: 'unknown',
            partner1Order: 0,
            partner2Order: 0,
          },
        ],
        children: ['me', 'sis'].map((childId, sortOrder) => ({
          familyId: 'F',
          childId,
          partner1Rel: 'biological' as const,
          partner2Rel: 'biological' as const,
          sortOrder,
          childOrder: 0,
          isPreferred: true,
        })),
        moreUp: [],
        moreDown: [],
      }),
    );
    expect(relationship(graph, 'sis', 'me').relationships[0]).toMatchObject({
      name: 'sister',
      generations: [1, 1],
      half: false,
      commonAncestors: ['dad'],
    });
  });
});

describe('chartPath', () => {
  it('lays a cousin path out as two columns under the common ancestor', () => {
    const [path] = relationship(family, 'cousin1', 'me').relationships[0]!.paths;
    expect(chartPath(path!)).toEqual([
      { id: 'cousin1', row: 2, col: 0 },
      { id: 'uncle', row: 1, col: 0 },
      { id: 'gf', row: 0, col: 0 },
      { id: 'dad', row: 1, col: 1 },
      { id: 'me', row: 2, col: 1 },
    ]);
  });

  it('gives each marriage its own column', () => {
    const [path] = relationship(family, 'stepsib', 'me').relationships[0]!.paths;
    expect(chartPath(path!)).toEqual([
      { id: 'stepsib', row: 1, col: 0 },
      { id: 'stepmom', row: 0, col: 0 },
      { id: 'dad', row: 0, col: 1 },
      { id: 'me', row: 1, col: 1 },
    ]);
    // A turn from going down to going up starts a new column.
    expect(
      chartPath({
        ids: ['a', 'kid', 'b'],
        steps: [{ kind: 'child' }, { kind: 'parent' }],
      }),
    ).toEqual([
      { id: 'a', row: 0, col: 0 },
      { id: 'kid', row: 1, col: 0 },
      { id: 'b', row: 0, col: 1 },
    ]);
  });
});
