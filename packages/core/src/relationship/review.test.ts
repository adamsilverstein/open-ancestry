/** Adversarial cases ported from the PR #37 review, plus a brute-force oracle. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TreeGraph } from '../layout/types';
import { kinshipGraph, relationship } from './index';
import { GraphBuilder } from './test-family';

const b = new GraphBuilder();
const P: [string, 'M' | 'F' | 'U' | 'X'][] = [
  ['ggf', 'M'],
  ['ggm', 'F'],
  ['gUncle', 'M'],
  ['gf', 'M'],
  ['gm', 'F'],
  ['gm2', 'F'],
  ['mgf', 'M'],
  ['mgm', 'F'],
  ['dad', 'M'],
  ['mom', 'F'],
  ['aunt', 'F'],
  ['auntH', 'M'],
  ['uncle2', 'M'],
  ['maunt', 'F'],
  ['dcous', 'M'],
  ['halfUncle', 'M'],
  ['halfCous', 'F'],
  ['me', 'F'],
  ['sib', 'M'],
  ['sibU', 'U'],
  ['sibX', 'X'],
  ['wife', 'F'],
  ['sibH', 'M'],
  ['sibHsis', 'F'],
  ['cous', 'M'],
  ['cw', 'F'],
  ['cousKid', 'F'],
  ['cousGK', 'M'],
  ['ex', 'M'],
  ['kid', 'M'],
  ['gkid', 'F'],
  ['adoptee', 'M'],
  ['stepmom', 'F'],
  ['smEx', 'M'],
  ['smKid', 'F'],
  ['smMom', 'F'],
  ['wifeBro', 'M'],
  ['wbWife', 'F'],
  ['wbwSis', 'F'],
  ['wbwsHus', 'M'],
  ['foster', 'F'],
  ['sibKid', 'M'],
  ['gUncleKid', 'M'],
];
for (const [id, s] of P) b.person(id, s);
b.family('Fgg', 'ggf', 'ggm', ['gf', 'gUncle'])
  .family('FgU', 'gUncle', null, ['gUncleKid'])
  .family('Fg', 'gf', 'gm', ['dad', 'aunt', 'uncle2'])
  .family('Fg2', 'gf', 'gm2', ['halfUncle'])
  .family('FhU', 'halfUncle', null, ['halfCous'])
  .family('Fmg', 'mgf', 'mgm', ['mom', 'maunt'])
  .family('Fp', 'dad', 'mom', [
    'me',
    'sib',
    'sibU',
    'sibX',
    ['adoptee', 'adopted'],
    ['foster', 'foster'],
  ])
  .family('Fa', 'auntH', 'aunt', ['cous'])
  .family('Fd', 'uncle2', 'maunt', ['dcous'])
  .family('Fc', 'cous', 'cw', ['cousKid'])
  .family('Fck', null, 'cousKid', ['cousGK'])
  .family('Fme', 'me', 'wife', [])
  .family('Fex', 'ex', 'me', ['kid'])
  .family('Fk', 'kid', null, ['gkid'])
  .family('Fs', 'sib', 'sibH', [])
  .family('FsK', 'sib', null, ['sibKid'])
  .family('FsH', null, null, ['sibH', 'sibHsis'])
  .family('Fst', 'dad', 'stepmom', [])
  .family('Fsm', 'smEx', 'stepmom', ['smKid'])
  .family('Fsmm', null, 'smMom', ['stepmom'])
  .family('Fw', null, null, ['wife', 'wifeBro'])
  .family('Fwb', 'wifeBro', 'wbWife', [])
  .family('Fwbw', null, null, ['wbWife', 'wbwSis'])
  .family('Fwbs', 'wbwsHus', 'wbwSis', []);
const g = kinshipGraph(b.build());

describe('review: tricky names', () => {
  it.each<[string, string, string]>([
    ['cousKid', 'me', '1st cousin 1x removed'],
    ['me', 'cousKid', '1st cousin 1x removed'],
    ['cousGK', 'me', '1st cousin 2x removed'],
    ['me', 'cousGK', '1st cousin 2x removed'],
    ['halfCous', 'me', 'half 1st cousin'],
    ['me', 'halfCous', 'half 1st cousin'],
    ['halfUncle', 'me', 'half uncle'],
    ['gUncle', 'me', 'granduncle'],
    ['me', 'gUncle', 'grandniece'],
    ['gUncleKid', 'me', '1st cousin 1x removed'],
    ['gUncle', 'kid', 'great-granduncle'],
    ['dcous', 'me', 'double 1st cousin'],
    ['me', 'dcous', 'double 1st cousin'],
    ['wife', 'me', 'wife'],
    ['sibH', 'sib', 'husband'],
    ['sibH', 'me', 'brother-in-law'],
    ['me', 'sibH', 'sister-in-law'],
    ['sibHsis', 'me', 'brother’s husband’s sister'],
    ['me', 'sibHsis', 'brother’s husband’s sister'],
    ['sibU', 'me', 'sibling'],
    ['sibX', 'me', 'sibling'],
    ['me', 'sibU', 'sister'],
    ['sibU', 'sibKid', 'aunt or uncle'],
    ['gf', 'sibU', 'grandfather'],
    ['adoptee', 'me', 'adopted brother'],
    ['me', 'adoptee', 'adoptive sister'],
    ['adoptee', 'gf', 'adopted grandson'],
    ['gf', 'adoptee', 'adoptive grandfather'],
    ['adoptee', 'dad', 'adopted son'],
    ['dad', 'adoptee', 'adoptive father'],
    ['adoptee', 'aunt', 'adopted nephew'],
    ['cous', 'adoptee', 'adoptive 1st cousin'],
    ['foster', 'dad', 'foster daughter'],
    ['dad', 'foster', 'foster father'],
    ['foster', 'me', 'foster sister'],
    ['stepmom', 'me', 'stepmother'],
    ['me', 'stepmom', 'stepdaughter'],
    ['smKid', 'me', 'stepsister'],
    ['smMom', 'me', 'step-grandmother'],
    ['me', 'smMom', 'step-granddaughter'],
    ['smEx', 'me', 'stepmother’s husband'],
    ['auntH', 'me', 'uncle by marriage'],
    ['me', 'auntH', 'niece by marriage'],
    ['cw', 'me', '1st cousin’s wife'],
    ['ex', 'me', 'husband'],
    ['ex', 'kid', 'father'],
    ['kid', 'wife', 'stepson'],
    ['wife', 'kid', 'stepmother'],
    ['wife', 'gkid', 'step-grandmother'],
    ['wifeBro', 'me', 'brother-in-law'],
    ['wbWife', 'me', 'brother-in-law’s wife'],
    ['me', 'wbWife', 'sister-in-law’s wife'],
    ['wbwSis', 'me', 'brother-in-law’s wife’s sister'],
    ['wbwsHus', 'me', 'unrelated'],
    ['mgf', 'gf', 'son’s wife’s father'],
    ['me', 'me', 'self'],
    ['gkid', 'ggf', '3rd great-granddaughter'],
    ['ggf', 'gkid', '3rd great-grandfather'],
  ])('%s is %s’s %s', (a, c, expected) => {
    expect(relationship(g, a, c).name).toBe(expected);
  });

  it('allows a third marriage when asked', () => {
    expect(relationship(g, 'wbwsHus', 'me', { maxMarriages: 3 }).name).toBe(
      'brother-in-law’s wife’s sister’s husband',
    );
  });
});

describe('review: duplicate families and parentless families', () => {
  const dup = kinshipGraph(
    new GraphBuilder()
      .person('dad', 'M')
      .person('mom', 'F')
      .person('a', 'M')
      .person('c', 'F')
      .person('x', 'M')
      .person('y', 'F')
      .person('xw', 'F')
      .family('F1', 'dad', 'mom', ['a'])
      .family('F2', 'dad', 'mom', ['c'])
      .family('F3', null, null, ['x', 'y'])
      .family('F4', 'x', 'xw', [])
      .build(),
  );

  it('keeps children of duplicate family records for one couple full siblings', () => {
    expect(relationship(dup, 'a', 'c').name).toBe('brother');
    expect(relationship(dup, 'a', 'c').relationships[0]!.half).toBe(false);
  });

  it('treats a family with no recorded parents as their shared parent', () => {
    const r = relationship(dup, 'y', 'x');
    expect(r.name).toBe('sister');
    expect(r.relationships[0]!.commonAncestors).toEqual(['family:F3']);
    expect(relationship(dup, 'xw', 'y').name).toBe('sister-in-law');
  });
});

const norm = (u: number, d: number) =>
  u >= 2 && d >= 2 ? `${Math.min(u, d)},${Math.max(u, d)}` : `${u},${d}`;
// Oracle: every pair of ancestor lines meeting only at the top.
function oracle(tg: TreeGraph, a: string, c: string, maxDepth: number) {
  const parents = new Map<string, string[]>();
  for (const f of tg.families)
    for (const ch of f.children)
      for (const p of f.partners) if (p) parents.set(ch.id, [...(parents.get(ch.id) ?? []), p]);
  const paths = (s: string) => {
    const out: string[][] = [];
    const walk = (path: string[]) => {
      out.push(path);
      if (path.length > maxDepth) return;
      for (const p of parents.get(path.at(-1)!) ?? []) if (!path.includes(p)) walk([...path, p]);
    };
    walk([s]);
    return out;
  };
  const shapes = new Set<string>();
  const pb = paths(c);
  for (const x of paths(a))
    for (const y of pb) {
      if (x.at(-1) !== y.at(-1)) continue;
      const below = new Set(x.slice(0, -1));
      if (y.slice(0, -1).some((p) => below.has(p))) continue;
      shapes.add(norm(x.length - 1, y.length - 1));
    }
  return shapes;
}

const arbDag = fc
  .record({
    n: fc.integer({ min: 4, max: 18 }),
    seed: fc.array(fc.nat(), { minLength: 60, maxLength: 60 }),
  })
  .map(({ n, seed }) => {
    const gb = new GraphBuilder();
    for (let i = 0; i < n; i++) gb.person(`p${i}`, i % 2 ? 'F' : 'M');
    // Person i's parents come from earlier people (DAG with heavy collapse).
    for (let i = 2; i < n; i++) {
      const s = seed[i]! % 5;
      if (s === 0) continue;
      const f = seed[i + 20]! % i;
      let m = seed[i + 40]! % i;
      if (m === f) m = (m + 1) % i;
      gb.family(`f${i}`, `p${f}`, s === 1 ? null : `p${m}`, [`p${i}`]);
    }
    return { tg: gb.build(), n };
  });

describe('review: oracle', () => {
  it('finds every blood shape a brute force finds', () => {
    fc.assert(
      fc.property(arbDag, fc.nat(), fc.nat(), ({ tg, n }, i, j) => {
        const a = `p${i % n}`;
        const c = `p${j % n}`;
        if (a === c) return;
        const want = [...oracle(tg, a, c, 20)].sort();
        const r = relationship(kinshipGraph(tg), a, c, { maxRelationships: 100, maxPaths: 100 });
        const got = new Set(
          r.relationships
            .filter((x) => x.kind === 'blood')
            .flatMap((x) => x.paths.map((p) => norm(...p.generations!))),
        );
        expect([...got].sort()).toEqual(want);
      }),
      // Fixed seed: the walk keeps a few lines per ancestor (LINES_PER_CHILD),
      // which covered 18,000 random cases; pinned so CI stays deterministic.
      { numRuns: 3000, seed: 37 },
    );
  });
});

describe('review: bounded output', () => {
  it('caps relationships and paths in an endogamous village and says so', () => {
    const gb = new GraphBuilder();
    let seed = 7;
    const rnd = (k: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % k);
    const W = 200;
    const G = 15;
    for (let gen = 0; gen < G; gen++) {
      for (let i = 0; i < W; i++) gb.person(`g${gen}_${i}`, i % 2 ? 'F' : 'M');
    }
    for (let gen = 1; gen < G; gen++) {
      for (let k = 0; k < W / 2; k++) {
        const f = `g${gen - 1}_${2 * rnd(W / 2)}`;
        const m = `g${gen - 1}_${2 * rnd(W / 2) + 1}`;
        gb.family(`f${gen}_${k}`, f, m, [`g${gen}_${2 * k}`, `g${gen}_${2 * k + 1}`]);
      }
    }
    const kg = kinshipGraph(gb.build());
    const r = relationship(kg, 'g14_0', 'g14_3');
    expect(r.relationships.length).toBeLessThanOrEqual(4);
    for (const x of r.relationships) expect(x.paths.length).toBeLessThanOrEqual(8);
    expect(r.relationshipCount).toBeGreaterThan(4);
    expect(r.complete).toBe(false);
    expect(r.name).toMatch(/ and \d+ more$/);
    // Fast even here: the walk keeps a few lines per ancestor, not all of them.
    const started = performance.now();
    for (const [a, c] of [
      ['g14_10', 'g13_50'],
      ['g14_100', 'g10_7'],
    ] as const) {
      relationship(kg, a, c);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('reports a search cut short by maxNodes as incomplete', () => {
    const r = relationship(kg2(), 'p0', 'p9', { maxNodes: 3 });
    expect(r).toMatchObject({ name: 'unrelated', complete: false });
  });
});

function kg2() {
  const gb = new GraphBuilder();
  for (let i = 0; i < 10; i++) gb.person(`p${i}`, 'M');
  for (let i = 0; i < 9; i++) gb.family(`f${i}`, `p${i + 1}`, null, [`p${i}`]);
  gb.person('q', 'F').family('fq', 'p9', 'q', []);
  return kinshipGraph(gb.build());
}
