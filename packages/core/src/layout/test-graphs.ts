/** Synthetic graphs for layout tests and benches. Not part of the public API. */
import fc from 'fast-check';
import type {
  ChildRelation,
  FanLayout,
  Sex,
  TreeFamily,
  TreeGraph,
  TreeLayout,
  TreePerson,
} from './types';

/** [familyId, partner1, partner2, children]; a child is an id or [id, relation to both]. */
export type FamilySpec = [
  string,
  string | null,
  string | null,
  (string | [string, ChildRelation])[],
];

export function makeGraph(people: Record<string, Sex>, families: FamilySpec[]): TreeGraph {
  const persons: Record<string, TreePerson> = {};
  for (const [id, sex] of Object.entries(people)) {
    persons[id] = { id, sex, name: id, living: false };
  }
  return {
    people: persons,
    families: families.map(([id, p1, p2, children]) => ({
      id,
      partners: [p1, p2],
      children: children.map((c) =>
        typeof c === 'string' ? { id: c } : { id: c[0], rel1: c[1], rel2: c[1] },
      ),
    })),
  };
}

/** Focus `me` with spouse `sp`, two children and both parents. */
export const nuclear = makeGraph({ dad: 'M', mom: 'F', me: 'M', sp: 'F', kid1: 'F', kid2: 'M' }, [
  ['F_par', 'dad', 'mom', ['me']],
  ['F_me', 'me', 'sp', ['kid1', 'kid2']],
]);

/** Focus `me` with parents, four grandparents and eight great-grandparents. */
export const threeGenerations = makeGraph(
  {
    me: 'F',
    dad: 'M',
    mom: 'F',
    pgf: 'M',
    pgm: 'F',
    mgf: 'M',
    mgm: 'F',
    ...Object.fromEntries(
      ['pgf', 'pgm', 'mgf', 'mgm'].flatMap((p) => [
        [`${p}_f`, 'M'],
        [`${p}_m`, 'F'],
      ]),
    ),
  },
  [
    ['F_me', 'dad', 'mom', ['me']],
    ['F_dad', 'pgf', 'pgm', ['dad']],
    ['F_mom', 'mgf', 'mgm', ['mom']],
    ...['pgf', 'pgm', 'mgf', 'mgm'].map((p): FamilySpec => [`F_${p}`, `${p}_f`, `${p}_m`, [p]]),
  ],
);

/** Focus `me` married three times, plus children with an unknown partner. */
export const multipleSpouses = makeGraph(
  { me: 'M', w1: 'F', w2: 'F', w3: 'F', a1: 'M', a2: 'F', b1: 'M', c1: 'F', c2: 'M', u1: 'F' },
  [
    ['F1', 'me', 'w1', ['a1', 'a2']],
    ['F2', 'me', 'w2', ['b1']],
    ['F3', 'me', 'w3', ['c1', 'c2']],
    ['F4', 'me', null, ['u1']],
  ],
);

/** Focus `me` was adopted; the biological parents are known too. */
export const adoption = makeGraph(
  { me: 'F', bdad: 'M', bmom: 'F', adad: 'M', amom: 'F', kid: 'M' },
  [
    ['F_adopt', 'adad', 'amom', [['me', 'adopted']]],
    ['F_bio', 'bdad', 'bmom', [['me', 'biological']]],
    ['F_me', 'me', null, [['kid', 'adopted']]],
  ],
);

/** Focus `me` whose parents are first cousins: the great-grandparents appear twice. */
export const cousinMarriage = makeGraph(
  { me: 'M', dad: 'M', mom: 'F', pgf: 'M', pgm: 'F', mgf: 'M', mgm: 'F', ggf: 'M', ggm: 'F' },
  [
    ['F_me', 'dad', 'mom', ['me']],
    ['F_dad', 'pgf', 'pgm', ['dad']],
    ['F_mom', 'mgf', 'mgm', ['mom']],
    // The paternal grandfather and maternal grandmother are siblings.
    ['F_gg', 'ggf', 'ggm', ['pgf', 'mgm']],
  ],
);

/** Focus `dad` with children by two partners: `a` and `b` are half siblings of `c`. */
export const halfSiblings = makeGraph(
  { dad: 'M', m1: 'F', m2: 'F', a: 'F', b: 'M', c: 'F', ck: 'M' },
  [
    ['F1', 'dad', 'm1', ['a', 'b']],
    ['F2', 'dad', 'm2', ['c']],
    ['F3', 'c', null, ['ck']],
  ],
);

export interface SyntheticTree {
  graph: TreeGraph;
  focusId: string;
}

/**
 * A full binary ancestry of `ancestors` generations above the focus plus a
 * descendant tree where every person has a spouse and `children` children,
 * `descendants` generations deep. Deterministic.
 */
export function syntheticTree(ancestors: number, descendants: number, children: number) {
  const people: Record<string, TreePerson> = {};
  const families: TreeFamily[] = [];
  const add = (id: string, sex: Sex) => {
    people[id] = { id, sex, name: id, living: false };
  };
  add('a1', 'M');
  // Ahnentafel numbering: a(2n) and a(2n+1) are the parents of a(n).
  for (let n = 1; n < 2 ** (ancestors + 1) / 2; n++) {
    add(`a${2 * n}`, 'M');
    add(`a${2 * n + 1}`, 'F');
    families.push({
      id: `fa${n}`,
      partners: [`a${2 * n}`, `a${2 * n + 1}`],
      children: [{ id: `a${n}` }],
    });
  }
  let generation = ['a1'];
  for (let g = 0; g < descendants; g++) {
    const next: string[] = [];
    for (const id of generation) {
      const spouse = `${id}s`;
      add(spouse, 'F');
      const kids = Array.from({ length: children }, (_, i) => `${id}.${i}`);
      for (const [i, kid] of kids.entries()) add(kid, i % 2 ? 'F' : 'M');
      families.push({
        id: `fd${id}`,
        partners: [id, spouse],
        children: kids.map((k) => ({ id: k })),
      });
      next.push(...kids);
    }
    generation = next;
  }
  return { graph: { people, families }, focusId: 'a1' } satisfies SyntheticTree;
}

/**
 * Random, often invalid graphs: cycles, people who are their own ancestors,
 * partners married to themselves, dangling ids and duplicate children.
 */
export const arbGraph: fc.Arbitrary<TreeGraph & { ids: string[] }> = fc
  .integer({ min: 1, max: 24 })
  .chain((n) => {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const id = fc.oneof(
      { weight: 10, arbitrary: fc.constantFrom(...ids) },
      { weight: 1, arbitrary: fc.constant('ghost') },
    );
    const partner = fc.option(id, { nil: null, freq: 5 });
    const rel = fc.option(
      fc.constantFrom<ChildRelation>('biological', 'adopted', 'step', 'unknown'),
      { nil: undefined },
    );
    return fc.record({
      ids: fc.constant(ids),
      sexes: fc.array(fc.constantFrom<Sex>('M', 'F', 'U', 'X'), { minLength: n, maxLength: n }),
      families: fc.array(
        fc.record({
          partners: fc.tuple(partner, partner),
          children: fc.array(fc.record({ id, rel1: rel, rel2: rel }), { maxLength: 4 }),
        }),
        { maxLength: n + 4 },
      ),
    });
  })
  .map(({ ids, sexes, families }) => ({
    ids,
    people: Object.fromEntries(
      ids.map((id, i): [string, TreePerson] => [
        id,
        { id, sex: sexes[i]!, name: id, living: false, hasMoreParents: i % 7 === 3 },
      ]),
    ),
    families: families.map((f, i) => ({
      id: `f${i}`,
      partners: f.partners,
      children: f.children.map((c) => {
        const child: TreeFamily['children'][number] = { id: c.id };
        if (c.rel1) return { ...child, rel1: c.rel1, rel2: c.rel2 };
        return child;
      }),
    })),
  }));

const round = (n: number) => Math.round(n * 10) / 10;

/** Compact text form of a layout for readable snapshots. */
export function describeLayout(layout: TreeLayout): string {
  const rows = new Map<number, string[]>();
  const nodes = [...layout.nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const n of nodes) {
    const flags = [
      n.isFocus ? 'focus' : '',
      n.isDuplicate ? `dup-of:${n.duplicateOf}` : '',
      n.canExpandUp ? '+up' : '',
      n.canCollapseUp ? '-up' : '',
      n.canExpandDown ? '+down' : '',
      n.canCollapseDown ? '-down' : '',
    ].filter(Boolean);
    const row = rows.get(n.y) ?? [];
    row.push(`${n.key}@${round(n.x)},${round(n.y)}${flags.length ? `[${flags.join(' ')}]` : ''}`);
    rows.set(n.y, row);
  }
  const lines = [...rows.values()].map((r) => r.join('  '));
  for (const e of layout.edges) {
    const pts = e.points.map(([x, y]) => `${round(x)},${round(y)}`).join(' ');
    const ends = [e.parents?.join('+'), e.child, e.rel].filter(Boolean).join(' ');
    lines.push(`${e.kind} ${e.familyId} ${ends} : ${pts}`);
  }
  for (const l of layout.labels)
    lines.push(`label ${l.generation} "${l.text}" @${round(l.x)},${round(l.y)}`);
  const b = layout.bounds;
  lines.push(`bounds ${round(b.minX)},${round(b.minY)} ${round(b.width)}x${round(b.height)}`);
  const alts = Object.entries(layout.alternateParentFamilies);
  for (const [id, a] of alts) lines.push(`parents ${id}: ${a.selected} of ${a.families.join(',')}`);
  return lines.join('\n');
}

export function describeFan(fan: FanLayout): string {
  const deg = (r: number) => Math.round((r * 180) / Math.PI);
  return fan.segments
    .map(
      (s) =>
        `${s.key} g${s.generation} #${s.ahnentafel} ${deg(s.startAngle)}..${deg(s.endAngle)}deg r${s.innerRadius}..${s.outerRadius}${s.isDuplicate ? ` dup-of:${s.duplicateOf}` : ''}`,
    )
    .join('\n');
}
