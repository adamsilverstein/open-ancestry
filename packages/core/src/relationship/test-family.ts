/** Synthetic families for relationship tests and benches. Not part of the public API. */
import type { ChildRelation, Sex, TreeFamily, TreeGraph, TreePerson } from '../layout/types';

/** A child, or [child, rel to partner 1, rel to partner 2]. */
type Child = string | [string, ChildRelation, ChildRelation?];

export class GraphBuilder {
  private readonly people: Record<string, TreePerson> = {};
  private readonly families: TreeFamily[] = [];

  person(id: string, sex: Sex): this {
    this.people[id] = { id, sex, name: id, living: false };
    return this;
  }

  /** Adds a family; partners and children must already exist (or be added later). */
  family(id: string, p1: string | null, p2: string | null, children: Child[] = []): this {
    this.families.push({
      id,
      partners: [p1, p2],
      children: children.map((c) =>
        typeof c === 'string' ? { id: c } : { id: c[0], rel1: c[1], rel2: c[2] ?? c[1] },
      ),
    });
    return this;
  }

  build(): TreeGraph {
    return { people: this.people, families: this.families };
  }
}

/**
 * The focus is `me` (F). Three generations up and four down, siblings and
 * half siblings, aunts, uncles and cousins on the father's side, in-laws,
 * step relatives, an adoption and a foster child. Every name is synthetic.
 */
export function bigFamily(): TreeGraph {
  const b = new GraphBuilder();
  const people: [string, Sex][] = [
    ['gggf', 'M'],
    ['gggm', 'F'],
    ['ggf', 'M'],
    ['ggm', 'F'],
    ['ggUncle', 'M'],
    ['ggUcousin', 'M'],
    ['gf', 'M'],
    ['gm', 'F'],
    ['gaunt', 'F'],
    ['gauntH', 'M'],
    ['gcousin', 'M'],
    ['gcw', 'F'],
    ['gc2', 'F'],
    ['gc3', 'M'],
    ['dad', 'M'],
    ['mom', 'F'],
    ['stepmom', 'F'],
    ['smEx', 'M'],
    ['stepsib', 'M'],
    ['exH', 'M'],
    ['uncle', 'M'],
    ['uncleW', 'F'],
    ['aunt', 'F'],
    ['auntH', 'M'],
    ['cousin1', 'M'],
    ['c1w', 'F'],
    ['c1kid', 'F'],
    ['c1gkid', 'M'],
    ['cousin2', 'F'],
    ['cousin3', 'M'],
    ['fosterkid', 'F'],
    ['me', 'F'],
    ['hus', 'M'],
    ['bro', 'M'],
    ['broW', 'F'],
    ['sis', 'F'],
    ['sisH', 'M'],
    ['halfbro', 'M'],
    ['halfsis', 'F'],
    ['halfnephew', 'M'],
    ['nephew', 'M'],
    ['gnephew', 'F'],
    ['niece', 'F'],
    ['kidU', 'U'],
    ['son', 'M'],
    ['sonW', 'F'],
    ['dau', 'F'],
    ['gson', 'M'],
    ['ggson', 'M'],
    ['gggson', 'M'],
    ['g4son', 'M'],
    ['adoptee', 'M'],
    ['husDad', 'M'],
    ['husMom', 'F'],
    ['husSis', 'F'],
    ['husSisH', 'M'],
    ['exW', 'F'],
    ['stepdau', 'F'],
    ['stranger', 'X'],
    ['dadStep', 'M'],
  ];
  for (const [id, sex] of people) b.person(id, sex);
  return (
    b
      .family('F_ggg', 'gggf', 'gggm', ['ggf', 'ggUncle'])
      .family('F_ggU', 'ggUncle', null, ['ggUcousin'])
      .family('F_gg', 'ggf', 'ggm', ['gf', 'gaunt'])
      .family('F_gaunt', 'gauntH', 'gaunt', ['gcousin'])
      .family('F_gcousin', 'gcousin', 'gcw', ['gc2'])
      .family('F_gc2', null, 'gc2', ['gc3'])
      .family('F_g', 'gf', 'gm', ['dad', 'uncle', 'aunt'])
      .family('F_uncle', 'uncle', 'uncleW', ['cousin1', 'cousin2', ['fosterkid', 'foster']])
      .family('F_cousin1', 'cousin1', 'c1w', ['c1kid'])
      .family('F_c1kid', null, 'c1kid', ['c1gkid'])
      .family('F_aunt', 'auntH', 'aunt', ['cousin3'])
      // dadStep is mom's son from before; recorded in the family as dad's stepson.
      .family('F_me', 'dad', 'mom', ['bro', 'me', 'sis', ['dadStep', 'step', 'biological']])
      .family('F_step', 'dad', 'stepmom', ['halfbro'])
      .family('F_smEx', 'smEx', 'stepmom', ['stepsib'])
      .family('F_exH', 'exH', 'mom', ['halfsis'])
      .family('F_halfbro', 'halfbro', null, ['halfnephew'])
      .family('F_bro', 'bro', 'broW', ['nephew', 'kidU'])
      .family('F_nephew', 'nephew', null, ['gnephew'])
      .family('F_sis', 'sisH', 'sis', ['niece'])
      .family('F_hus', 'hus', 'me', ['son', 'dau', ['adoptee', 'adopted']])
      .family('F_son', 'son', 'sonW', ['gson'])
      .family('F_gson', 'gson', null, ['ggson'])
      .family('F_ggson', 'ggson', null, ['gggson'])
      .family('F_gggson', 'gggson', null, ['g4son'])
      .family('F_husP', 'husDad', 'husMom', ['hus', 'husSis'])
      .family('F_husSis', 'husSisH', 'husSis', [])
      .family('F_exW', 'hus', 'exW', ['stepdau'])
      .build()
  );
}

/** Brothers b1 and b2 married sisters s1 and s2: k1 and k2 are double first cousins. */
export function doubleCousins(): TreeGraph {
  const b = new GraphBuilder();
  for (const [id, sex] of [
    ['pf', 'M'],
    ['pm', 'F'],
    ['mf', 'M'],
    ['mm', 'F'],
    ['b1', 'M'],
    ['b2', 'M'],
    ['s1', 'F'],
    ['s2', 'F'],
    ['k1', 'M'],
    ['k2', 'F'],
  ] as [string, Sex][]) {
    b.person(id, sex);
  }
  return b
    .family('F_p', 'pf', 'pm', ['b1', 'b2'])
    .family('F_m', 'mf', 'mm', ['s1', 's2'])
    .family('F_1', 'b1', 's1', ['k1'])
    .family('F_2', 'b2', 's2', ['k2'])
    .build();
}

/**
 * A and B are 2nd cousins through the P couple, and also 3rd cousins once
 * removed through the Q couple: pedigree collapse with two distinct names.
 */
export function collapse(): TreeGraph {
  const b = new GraphBuilder();
  for (const [id, sex] of [
    ['p1', 'M'],
    ['p2', 'F'],
    ['x', 'M'],
    ['y', 'M'],
    ['x1', 'M'],
    ['y1', 'M'],
    ['q1', 'M'],
    ['q2', 'F'],
    ['u', 'F'],
    ['v', 'F'],
    ['u1', 'F'],
    ['u2', 'F'],
    ['u3', 'F'],
    ['v1', 'F'],
    ['v2', 'F'],
    ['A', 'M'],
    ['B', 'F'],
  ] as [string, Sex][]) {
    b.person(id, sex);
  }
  return b
    .family('F_p', 'p1', 'p2', ['x', 'y'])
    .family('F_x', 'x', null, ['x1'])
    .family('F_y', 'y', null, ['y1'])
    .family('F_q', 'q1', 'q2', ['u', 'v'])
    .family('F_u', null, 'u', ['u1'])
    .family('F_u1', null, 'u1', ['u2'])
    .family('F_u2', null, 'u2', ['u3'])
    .family('F_v', null, 'v', ['v1'])
    .family('F_v1', null, 'v1', ['v2'])
    .family('F_A', 'x1', 'u3', ['A'])
    .family('F_B', 'y1', 'v2', ['B'])
    .build();
}

/** Parents who are first cousins: their child reaches the great-grandparents twice. */
export function cousinParents(): TreeGraph {
  const b = new GraphBuilder();
  for (const [id, sex] of [
    ['ggf', 'M'],
    ['ggm', 'F'],
    ['ga', 'M'],
    ['gb', 'F'],
    ['dad', 'M'],
    ['mom', 'F'],
    ['me', 'F'],
  ] as [string, Sex][]) {
    b.person(id, sex);
  }
  return b
    .family('F_gg', 'ggf', 'ggm', ['ga', 'gb'])
    .family('F_a', 'ga', null, ['dad'])
    .family('F_b', null, 'gb', ['mom'])
    .family('F_me', 'dad', 'mom', ['me'])
    .build();
}

/** Seeded PRNG (mulberry32) so benches and tests are deterministic. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * About `size` people descending from one couple over many generations, with
 * married-in spouses, remarriages and the odd cousin marriage. Deterministic.
 */
export function randomTree(size: number, seed = 1): { graph: TreeGraph; ids: string[] } {
  const random = rng(seed);
  const b = new GraphBuilder();
  let n = 0;
  const add = (sex: Sex) => {
    const id = `p${n++}`;
    b.person(id, sex);
    return id;
  };
  let generation = [add('M')];
  const all = [...generation];
  const known = new Set(all);
  let families = 0;
  while (n < size && generation.length) {
    const next: string[] = [];
    for (const person of generation) {
      if (n >= size) break;
      const marriages = random() < 0.1 ? 2 : random() < 0.85 ? 1 : 0;
      for (let m = 0; m < marriages; m++) {
        // Occasionally marry someone already in the tree (pedigree collapse).
        const spouse =
          random() < 0.02 && next.length ? next[Math.floor(random() * next.length)]! : add('F');
        if (!known.has(spouse)) {
          known.add(spouse);
          all.push(spouse);
        }
        const kids = Array.from(
          { length: Math.floor(random() * 4) + (generation.length < 4 ? 2 : 0) },
          () => add(random() < 0.5 ? 'M' : 'F'),
        );
        b.family(`f${families++}`, person, spouse, kids);
        next.push(...kids);
        all.push(...kids);
        for (const kid of kids) known.add(kid);
      }
    }
    generation = next;
  }
  return { graph: b.build(), ids: all };
}
