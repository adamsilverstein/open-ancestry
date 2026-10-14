import type { ChildRelation, LayoutNode, TreeGraph, TreeLayout } from '@open-ancestry/core';

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
  siblings: Map<string, string[]>;
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

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

const rowKey = (n: LayoutNode) => `${n.generation}:${n.y}`;

export function buildRelations(layout: TreeLayout, graph?: TreeGraph): Relations {
  const nodes = new Map(layout.nodes.map((n) => [n.key, n]));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const partners = new Map<string, string[]>();
  const siblings = new Map<string, string[]>();
  const links = new Map<string, ChildRelation>();
  const groupParents = new Map<string, string[]>();
  const groupChildren = new Map<string, string[]>();
  /** The family each child drop comes from (`group\nchild`). */
  const childFamily = new Map<string, string>();

  for (const edge of layout.edges) {
    if (edge.kind === 'couple' && edge.parents?.length === 2) {
      const [a, b] = edge.parents as [string, string];
      push(partners, a, b);
      push(partners, b, a);
    } else if (edge.kind === 'parent-child') {
      // The pedigree draws one edge per parent: gather them.
      for (const p of edge.parents ?? []) push(groupParents, edge.group, p);
      if (edge.child) {
        push(groupChildren, edge.group, edge.child);
        childFamily.set(`${edge.group}\n${edge.child}`, edge.familyId);
      }
    }
  }
  const families = new Map(graph?.families.map((f) => [f.id, f]));
  for (const [group, kids] of groupChildren) {
    const ps = groupParents.get(group) ?? [];
    for (const kid of kids) {
      const family = families.get(childFamily.get(`${group}\n${kid}`)!);
      const entry = family?.children.find((c) => c.id === nodes.get(kid)?.personId);
      for (const p of ps) {
        push(parents, kid, p);
        push(children, p, kid);
        const side = family?.partners.indexOf(nodes.get(p)?.personId ?? null);
        const rel = side === 0 ? entry?.rel1 : side === 1 ? entry?.rel2 : undefined;
        if (rel && rel !== 'biological' && rel !== 'unknown') links.set(`${kid}\n${p}`, rel);
      }
      for (const other of kids) if (other !== kid) push(siblings, kid, other);
    }
  }

  const rows = new Map<string, LayoutNode[]>();
  for (const node of layout.nodes) {
    const list = rows.get(rowKey(node));
    if (list) list.push(node);
    else rows.set(rowKey(node), [node]);
  }
  for (const list of rows.values()) list.sort((a, b) => a.x - b.x);

  return { nodes, parents, children, partners, siblings, rows, links };
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
type Qualifier = 'step' | 'adoptive' | 'foster' | 'half';

const LINK_QUALIFIER: Partial<Record<ChildRelation, Qualifier>> = {
  step: 'step',
  adopted: 'adoptive',
  foster: 'foster',
};

/** Parents by birth or adoption make full siblings; step and foster parents do not. */
const sharesFamily = (rel: ChildRelation | undefined) => rel === undefined || rel === 'adopted';

/** Half, step or foster when two siblings do not share all their parents. */
function siblingQualifier(rel: Relations, a: string, b: string): Qualifier | undefined {
  const theirs = rel.parents.get(b) ?? [];
  const common = (rel.parents.get(a) ?? []).filter((p) => theirs.includes(p));
  const linkOf = (child: string, p: string) => rel.links.get(`${child}\n${p}`);
  const shared = common.filter((p) => sharesFamily(linkOf(a, p)) && sharesFamily(linkOf(b, p)));
  if (shared.length === common.length) return undefined;
  if (shared.length > 0) return 'half';
  return common.some((p) => linkOf(a, p) === 'foster' || linkOf(b, p) === 'foster')
    ? 'foster'
    : 'step';
}

interface KinPath {
  /** Steps: U(p), D(own), S(pouse), B(rother or sister). */
  path: string;
  /** The first link off birth on a straight line up or down, or the sibling link. */
  qualifier?: Qualifier;
}

function kinshipPaths(rel: Relations, focusKey: string, stopAt?: string): Map<string, KinPath> {
  const paths = new Map<string, KinPath>([[focusKey, { path: '' }]]);
  let frontier = [focusKey];
  while (frontier.length > 0 && !(stopAt && paths.has(stopAt))) {
    const next: string[] = [];
    for (const from of frontier) {
      const { path, qualifier } = paths.get(from)!;
      if (path.length >= 4) continue;
      const steps: [string, string[] | undefined][] = [
        ['B', rel.siblings.get(from)],
        ['U', rel.parents.get(from)],
        ['D', rel.children.get(from)],
        ['S', rel.partners.get(from)],
      ];
      for (const [step, keys] of steps) {
        for (const to of keys ?? []) {
          if (paths.has(to)) continue;
          const link =
            step === 'U'
              ? rel.links.get(`${from}\n${to}`)
              : step === 'D'
                ? rel.links.get(`${to}\n${from}`)
                : undefined;
          paths.set(to, {
            path: path + step,
            qualifier:
              step === 'B'
                ? siblingQualifier(rel, from, to)
                : (qualifier ?? (link ? LINK_QUALIFIER[link] : undefined)),
          });
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return paths;
}

/** `stepfather`, `step-grandmother`, `adoptive father`, `foster son`... */
function qualified(term: string, qualifier: Qualifier | undefined, generations: number): string {
  if (qualifier === 'step') return generations === 1 ? `step${term}` : `step-${term}`;
  if (qualifier === 'adoptive' || qualifier === 'foster') return `${qualifier} ${term}`;
  return term;
}

function term({ path, qualifier }: KinPath, sex: Sex, half: boolean): string | null {
  if (/^U+$/.test(path)) return qualified(ancestorTerm(path.length, sex), qualifier, path.length);
  if (/^D+$/.test(path)) {
    const base = descendantTerm(path.length, sex);
    // A parent names an adopted child "adopted son", not "adoptive son".
    return qualifier === 'adoptive' ? `adopted ${base}` : qualified(base, qualifier, path.length);
  }
  if (path === 'B' && qualifier && qualifier !== 'half') {
    return qualified(gendered(sex, 'brother', 'sister', 'sibling'), qualifier, 1);
  }
  const h = half || qualifier === 'half' ? 'half-' : '';
  switch (path.replace('UD', 'B')) {
    case 'S':
      return gendered(sex, 'husband', 'wife', 'spouse');
    case 'B':
      return h + gendered(sex, 'brother', 'sister', 'sibling');
    case 'UB':
    case 'UBS':
      return h + gendered(sex, 'uncle', 'aunt', 'parent’s sibling');
    case 'BS':
      return gendered(sex, 'brother-in-law', 'sister-in-law', 'sibling-in-law');
    case 'DS':
      return gendered(sex, 'son-in-law', 'daughter-in-law', 'child-in-law');
    case 'SU':
      return gendered(sex, 'father-in-law', 'mother-in-law', 'parent-in-law');
    case 'BD':
      return gendered(sex, 'nephew', 'niece', 'sibling’s child');
    case 'UBD':
      return 'cousin';
    case 'SD':
      return gendered(sex, 'stepson', 'stepdaughter', 'stepchild');
    default:
      return null;
  }
}

/**
 * How `key` is related to the focus card, in words (`father`, `aunt`,
 * `son-in-law`), or null for the focus person and relationships too
 * distant or unusual to name from the cards on screen.
 */
export function kinship(
  rel: Relations,
  focusKey: string,
  key: string,
  sexOf: (key: string) => Sex,
): string | null {
  if (key === focusKey || !rel.nodes.has(key) || !rel.nodes.has(focusKey)) return null;
  const path = kinshipPaths(rel, focusKey, key).get(key);
  return path?.path ? term(path, sexOf(key), rel.nodes.get(key)?.isHalfSibling === true) : null;
}

/** Every card's kinship to the focus card from one breadth-first walk. */
export function kinshipLabels(
  rel: Relations,
  focusKey: string,
  sexOf: (key: string) => Sex,
): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!rel.nodes.has(focusKey)) return labels;
  for (const [key, path] of kinshipPaths(rel, focusKey)) {
    if (!path.path) continue;
    const label = term(path, sexOf(key), rel.nodes.get(key)?.isHalfSibling === true);
    if (label) labels[key] = label;
  }
  return labels;
}
