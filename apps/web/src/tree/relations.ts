import type {
  ChildRelation,
  LayoutNode,
  TreeFamily,
  TreeFamilyChild,
  TreeGraph,
  TreeLayout,
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

export function buildRelations(layout: TreeLayout, graph?: TreeGraph): Relations {
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
  const families = new Map(graph?.families.map((f) => [f.id, f]));
  // Each family's child entries by person, built once (a scan per child would be k²).
  const entries = new Map<string, Map<string, TreeFamilyChild>>();
  const entryOf = (family: TreeFamily, personId: string | undefined) => {
    let byId = entries.get(family.id);
    if (!byId) {
      byId = new Map();
      for (const c of family.children) if (!byId.has(c.id)) byId.set(c.id, c);
      entries.set(family.id, byId);
    }
    return personId === undefined ? undefined : byId.get(personId);
  };
  for (const [group, kids] of groupChildren.lists) {
    const ps = groupParents.lists.get(group) ?? [];
    for (const kid of kids) {
      const family = families.get(childFamily.get(`${group}\n${kid}`)!);
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
type Qualifier = 'step' | 'adoptive' | 'foster' | 'half' | 'adopted';

const LINK_QUALIFIER: Partial<Record<ChildRelation, Qualifier>> = {
  step: 'step',
  adopted: 'adoptive',
  foster: 'foster',
};

/** Step and foster parents do not make family; birth, adoption, guardians and the rest do. */
const sharesFamily = (rel: ChildRelation | undefined) => rel !== 'step' && rel !== 'foster';

/**
 * How sibling `b` is related to `a` through the parents they share: half
 * when they share only some by birth or adoption (or the layout says so),
 * or one by birth and another only by adoption; step or foster when they
 * share none; adopted when only an adoption joins them.
 */
function siblingQualifier(rel: Relations, a: string, b: string): Qualifier | undefined {
  const theirs = rel.parents.get(b) ?? [];
  const common = (rel.parents.get(a) ?? []).filter((p) => theirs.includes(p));
  if (common.length === 0) return rel.nodes.get(b)?.isHalfSibling ? 'half' : undefined;
  const linkOf = (child: string, p: string) => rel.links.get(`${child}\n${p}`);
  const shared = common.filter((p) => sharesFamily(linkOf(a, p)) && sharesFamily(linkOf(b, p)));
  if (shared.length === 0) {
    return common.some((p) => linkOf(a, p) === 'foster' || linkOf(b, p) === 'foster')
      ? 'foster'
      : 'step';
  }
  if (shared.length < common.length || rel.nodes.get(b)?.isHalfSibling) return 'half';
  // A parent by birth to both makes them blood relatives: half when another
  // shared parent is so only by adoption (a stepfather who adopted).
  const notAdopted = (child: string, p: string) => linkOf(child, p) !== 'adopted';
  const byBirth = shared.filter((p) => notAdopted(a, p) && notAdopted(b, p));
  if (byBirth.length === shared.length) return undefined;
  return byBirth.length > 0 ? 'half' : 'adopted';
}

/** Qualifiers that carry on to the relatives reached through that person. */
const carries = (q: Qualifier | undefined) => q === 'step' || q === 'foster';

interface KinPath {
  /** Steps: U(p), D(own), S(pouse), B(rother or sister). */
  path: string;
  /**
   * Straight up or down: the first link off birth. Collateral kin: how the
   * siblings on the path are siblings, unless a step or foster link before
   * them already made the whole line step or foster.
   */
  qualifier?: Qualifier;
  /** The card the path came from. */
  via?: string;
}

function kinshipPaths(rel: Relations, focusKey: string, stopAt?: string): Map<string, KinPath> {
  const paths = new Map<string, KinPath>([[focusKey, { path: '' }]]);
  // Sibling lists are shared by the whole group: the first member to reach one
  // (the nearest, as the walk is breadth-first) labels all the others.
  const walked = new Set<readonly string[]>();
  let frontier = [focusKey];
  while (frontier.length > 0 && !(stopAt && paths.has(stopAt))) {
    const next: string[] = [];
    for (const from of frontier) {
      const here = paths.get(from)!;
      if (here.path.length >= 4) continue;
      const steps: [string, readonly string[] | undefined][] = [
        ['B', rel.siblings.get(from)],
        ['U', rel.parents.get(from)],
        ['D', rel.children.get(from)],
        ['S', rel.partners.get(from)],
      ];
      for (const [step, keys] of steps) {
        if (!keys || walked.has(keys)) continue;
        if (step === 'B') walked.add(keys);
        for (const to of keys) {
          if (paths.has(to)) continue;
          const path = here.path + step;
          let qualifier: Qualifier | undefined;
          // A sibling, next to us or down from a parent we went up to.
          const sibling = step === 'B' ? from : path.endsWith('UD') ? here.via : undefined;
          if (sibling !== undefined) {
            const before = paths.get(sibling)!.qualifier;
            qualifier = carries(before) ? before : siblingQualifier(rel, sibling, to);
          } else {
            const link =
              step === 'U'
                ? rel.links.get(`${from}\n${to}`)
                : step === 'D'
                  ? rel.links.get(`${to}\n${from}`)
                  : undefined;
            qualifier = here.qualifier ?? (link ? LINK_QUALIFIER[link] : undefined);
          }
          paths.set(to, { path, qualifier, via: from });
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
  if (qualifier === 'adoptive' || qualifier === 'foster' || qualifier === 'adopted') {
    return `${qualifier} ${term}`;
  }
  if (qualifier === 'half') return `half-${term}`;
  return term;
}

function term({ path, qualifier }: KinPath, sex: Sex): string | null {
  if (/^U+$/.test(path)) return qualified(ancestorTerm(path.length, sex), qualifier, path.length);
  if (/^D+$/.test(path)) {
    const base = descendantTerm(path.length, sex);
    // A parent names an adopted child "adopted son", not "adoptive son".
    return qualified(base, qualifier === 'adoptive' ? 'adopted' : qualifier, path.length);
  }
  // Only step, foster and half carry to aunts, nephews and cousins.
  const collateral = qualifier === 'adopted' ? undefined : qualifier;
  switch (path.replace('UD', 'B')) {
    case 'S':
      return gendered(sex, 'husband', 'wife', 'spouse');
    case 'B':
      return qualified(gendered(sex, 'brother', 'sister', 'sibling'), qualifier, 1);
    case 'UB':
    case 'UBS':
      return qualified(gendered(sex, 'uncle', 'aunt', 'parent’s sibling'), collateral, 2);
    case 'BS':
      return gendered(sex, 'brother-in-law', 'sister-in-law', 'sibling-in-law');
    case 'DS':
      return gendered(sex, 'son-in-law', 'daughter-in-law', 'child-in-law');
    case 'SU':
      return gendered(sex, 'father-in-law', 'mother-in-law', 'parent-in-law');
    case 'BD':
      return qualified(gendered(sex, 'nephew', 'niece', 'sibling’s child'), collateral, 2);
    case 'UBD':
      return qualified('cousin', collateral, 2);
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
  return path?.path ? term(path, sexOf(key)) : null;
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
    const label = term(path, sexOf(key));
    if (label) labels[key] = label;
  }
  return labels;
}
