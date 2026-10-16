import {
  asIndex,
  cardTerm,
  type CardStep,
  type ChildRelation,
  type GraphSource,
  type LayoutNode,
  type SharedAdult,
  type TreeFamily,
  type TreeLayout,
} from '@open-ancestry/core';

/**
 * Who is related to whom among the laid-out cards, read back from the layout's
 * edges. Keys are layout node keys, so duplicates (pedigree collapse) keep
 * their own links. Drives arrow-key navigation and the cards' kinship labels.
 */
export interface Relations {
  nodes: Map<string, LayoutNode>;
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
  partners: Map<string, string[]>;
  /**
   * Each card's brothers and sisters, the card itself included: one list per
   * sibling group, shared by every member, so a family of k children costs k
   * rather than k² entries.
   */
  siblings: Map<string, readonly string[]>;
  /** Cards sharing a row, left to right. */
  rows: Map<string, LayoutNode[]>;
  /**
   * How a child card is linked to a parent card (`child\nparent`), when the
   * link is not by birth: step, adopted, foster... Needs the graph.
   */
  links: Map<string, ChildRelation>;
}

export type Direction = 'up' | 'down' | 'left' | 'right';
type Sex = 'M' | 'F' | 'U' | 'X';

/** Adds `value` to `key`'s list once; the sets make the check O(1). */
function linker() {
  const lists = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();
  const push = (key: string, value: string) => {
    const set = seen.get(key);
    if (!set) {
      seen.set(key, new Set([value]));
      lists.set(key, [value]);
    } else if (!set.has(value)) {
      set.add(value);
      lists.get(key)!.push(value);
    }
  };
  return { lists, push };
}

const rowKey = (n: LayoutNode) => `${n.generation}:${n.y}`;

export function buildRelations(layout: TreeLayout, graph?: GraphSource): Relations {
  const nodes = new Map(layout.nodes.map((n) => [n.key, n]));
  const parents = linker();
  const children = linker();
  const partners = linker();
  const siblings = new Map<string, readonly string[]>();
  const links = new Map<string, ChildRelation>();
  const groupParents = linker();
  const groupChildren = linker();
  /** The family each child drop comes from (`group\nchild`). */
  const childFamily = new Map<string, string>();

  for (const edge of layout.edges) {
    if (edge.kind === 'couple' && edge.parents?.length === 2) {
      const [a, b] = edge.parents as [string, string];
      partners.push(a, b);
      partners.push(b, a);
    } else if (edge.kind === 'parent-child') {
      // The pedigree draws one edge per parent: gather them.
      for (const p of edge.parents ?? []) groupParents.push(edge.group, p);
      if (edge.child) {
        groupChildren.push(edge.group, edge.child);
        childFamily.set(`${edge.group}\n${edge.child}`, edge.familyId);
      }
    }
  }
  // Lookups by id through the index (the worker's is kept with its graph cache),
  // so labelling costs the cards on screen, not every family merged.
  const index = graph && asIndex(graph);
  const entryOf = (family: TreeFamily, personId: string | undefined) =>
    personId === undefined ? undefined : index?.entry(family, personId);
  for (const [group, kids] of groupChildren.lists) {
    const ps = groupParents.lists.get(group) ?? [];
    for (const kid of kids) {
      const family = index?.family(childFamily.get(`${group}\n${kid}`)!);
      const entry = family && entryOf(family, nodes.get(kid)?.personId);
      for (const p of ps) {
        parents.push(kid, p);
        children.push(p, kid);
        const side = family?.partners.indexOf(nodes.get(p)?.personId ?? null);
        const rel = side === 0 ? entry?.rel1 : side === 1 ? entry?.rel2 : undefined;
        if (rel && rel !== 'biological' && rel !== 'unknown') links.set(`${kid}\n${p}`, rel);
      }
      const other = siblings.get(kid);
      // In two sibling groups (rare): a list of its own, merging both.
      siblings.set(kid, other ? [...new Set([...other, ...kids])] : kids);
    }
  }

  const rows = new Map<string, LayoutNode[]>();
  for (const node of layout.nodes) {
    const list = rows.get(rowKey(node));
    if (list) list.push(node);
    else rows.set(rowKey(node), [node]);
  }
  for (const list of rows.values()) list.sort((a, b) => a.x - b.x);

  return {
    nodes,
    parents: parents.lists,
    children: children.lists,
    partners: partners.lists,
    siblings,
    rows,
    links,
  };
}

/**
 * The card an arrow key moves to: up a parent, down the nearest child, left
 * and right the next card in the row (spouses and siblings). Null when there
 * is none, so the key can fall back to panning.
 */
export function neighbor(rel: Relations, key: string, direction: Direction): string | null {
  const node = rel.nodes.get(key);
  if (!node) return null;
  const center = node.x + node.width / 2;
  if (direction === 'up') {
    // Prefer the blood relative over a parent who married in.
    const ps = rel.parents.get(key) ?? [];
    const line = ps.find((p) => rel.nodes.get(p)?.isFocus || rel.parents.has(p));
    return line ?? ps[0] ?? null;
  }
  if (direction === 'down') {
    // A person's children may hang from any of their couples. Prefer the
    // direct line (a child with their own children or the focus person).
    const all = rel.children.get(key) ?? [];
    const line = all.filter((k) => rel.nodes.get(k)?.isFocus || rel.children.has(k));
    const kids = line.length > 0 ? line : all;
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const kid of kids) {
      const k = rel.nodes.get(kid);
      if (!k) continue;
      const distance = Math.abs(k.x + k.width / 2 - center);
      if (distance < bestDistance) {
        best = kid;
        bestDistance = distance;
      }
    }
    return best;
  }
  const row = rel.rows.get(rowKey(node)) ?? [];
  const index = row.indexOf(node);
  const next = row[direction === 'left' ? index - 1 : index + 1];
  return next?.key ?? null;
}

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${s}`;
};

const gendered = (sex: Sex, male: string, female: string, other: string) =>
  sex === 'M' ? male : sex === 'F' ? female : other;

/** `father`, `grandmother`, `great-grandparent`, `2nd great-grandfather`... */
export function ancestorTerm(generations: number, sex: Sex): string {
  const base = gendered(sex, 'father', 'mother', 'parent');
  return lineTerm(generations, base);
}

export function descendantTerm(generations: number, sex: Sex): string {
  return lineTerm(generations, gendered(sex, 'son', 'daughter', 'child'));
}

function lineTerm(n: number, base: string): string {
  if (n === 1) return base;
  if (n === 2) return `grand${base}`;
  if (n === 3) return `great-grand${base}`;
  return `${ordinal(n - 2)} great-grand${base}`;
}

/** How a link differs from one by birth, as the words for it say. */
/** The link from a child card to a parent card; missing means by birth. */
const linkOf = (rel: Relations, child: string, parent: string): ChildRelation =>
  rel.links.get(`${child}\n${parent}`) ?? 'biological';

/** How two cards' shared parents join them, for core's siblingKind: [mine, theirs] per parent. */
function sharedParents(rel: Relations, a: string, b: string): SharedAdult[] {
  const theirs = rel.parents.get(b) ?? [];
  return (rel.parents.get(a) ?? [])
    .filter((p) => theirs.includes(p))
    .map((p) => [linkOf(rel, a, p), linkOf(rel, b, p)] as const);
}

/** Longest path named, except straight lines up or down (3rd great-grandparents and beyond). */
const MAX_PATH = 4;
const MAX_LINE = 10;

interface KinPath {
  /** The steps from the focus card, as core's cardTerm reads them. */
  steps: CardStep[];
  /** U(p), D(own), S(pouse), B(rother or sister), one letter per step taken. */
  path: string;
  /** The card the path came from. */
  via?: string;
}

function kinshipPaths(
  rel: Relations,
  focusKey: string,
  sexOf: (key: string) => Sex,
  stopAt?: string,
): Map<string, KinPath> {
  const paths = new Map<string, KinPath>([[focusKey, { steps: [], path: '' }]]);
  // Sibling lists are shared by the whole group: the first member to reach one
  // (the nearest, as the walk is breadth-first) labels all the others.
  const walked = new Set<readonly string[]>();
  let frontier = [focusKey];
  while (frontier.length > 0 && !(stopAt && paths.has(stopAt))) {
    const next: string[] = [];
    for (const from of frontier) {
      const here = paths.get(from)!;
      const line = /^(U+|D+)$/.test(here.path);
      if (here.path.length >= (line ? MAX_LINE : MAX_PATH)) continue;
      const moves: [CardStep['step'], readonly string[] | undefined][] = [
        ['B', rel.siblings.get(from)],
        ['U', rel.parents.get(from)],
        ['D', rel.children.get(from)],
        ['S', rel.partners.get(from)],
      ];
      for (const [step, keys] of moves) {
        if (!keys || walked.has(keys)) continue;
        if (step === 'B') walked.add(keys);
        for (const to of keys) {
          if (paths.has(to)) continue;
          // Past the first step, only straight lines go beyond MAX_PATH.
          const path = here.path + step;
          if (path.length > MAX_PATH && !/^(U+|D+)$/.test(path)) continue;
          const sex = sexOf(to);
          let steps: CardStep[];
          if (step === 'B') {
            steps = [...here.steps, { step, shared: sharedParents(rel, from, to), sex }];
          } else if (step === 'D' && here.path.endsWith('U') && here.via !== undefined) {
            // Up to a parent and down to another of their children: a sibling
            // through that parent's other partnership (a half or stepsibling).
            const sibling = here.via;
            steps = [
              ...here.steps.slice(0, -1),
              {
                step: 'B',
                shared: [[linkOf(rel, sibling, from), linkOf(rel, to, from)]],
                apart: true,
                sex,
              },
            ];
          } else if (step === 'S') {
            steps = [...here.steps, { step, sex }];
          } else {
            const link = step === 'U' ? linkOf(rel, from, to) : linkOf(rel, to, from);
            steps = [...here.steps, { step, rel: link, sex }];
          }
          paths.set(to, { steps, path, via: from });
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return paths;
}

/** A step's identity for naming: everything cardTerm reads from it. */
const stepKey = (s: CardStep) =>
  s.step === 'B'
    ? `B${s.sex}${s.apart ? 'a' : ''}${s.shared?.map(([a, b]) => `${a},${b}`).join(';') ?? s.kind}`
    : s.step === 'S'
      ? `S${s.sex}`
      : `${s.step}${s.sex}${s.rel}`;

/**
 * How `key` is related to the focus card, in the relationship calculator's
 * words (`father`, `half-aunt`, `guardian`, `wife of uncle`), or null for
 * the focus person and relationships too distant or unusual to name from
 * the cards on screen.
 */
export function kinship(
  rel: Relations,
  focusKey: string,
  key: string,
  sexOf: (key: string) => Sex,
): string | null {
  if (key === focusKey || !rel.nodes.has(key) || !rel.nodes.has(focusKey)) return null;
  const path = kinshipPaths(rel, focusKey, sexOf, key).get(key);
  return (path?.steps.length && cardTerm(path.steps, sexOf(key))) || null;
}

/** Every card's kinship to the focus card from one breadth-first walk. */
export function kinshipLabels(
  rel: Relations,
  focusKey: string,
  sexOf: (key: string) => Sex,
): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!rel.nodes.has(focusKey)) return labels;
  // Thousands of cards share a handful of shapes (every child of a big
  // family is "son" or "daughter"): name each shape once.
  const named = new Map<string, string | undefined>();
  for (const [key, path] of kinshipPaths(rel, focusKey, sexOf)) {
    if (!path.steps.length) continue;
    const sex = sexOf(key);
    const shape = sex + path.steps.map(stepKey).join('|');
    let label = named.get(shape);
    if (!named.has(shape)) named.set(shape, (label = cardTerm(path.steps, sex)));
    if (label) labels[key] = label;
  }
  return labels;
}
