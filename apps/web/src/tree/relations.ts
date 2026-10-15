import type { LayoutNode, TreeLayout } from '@open-ancestry/core';

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

export function buildRelations(layout: TreeLayout): Relations {
  const nodes = new Map(layout.nodes.map((n) => [n.key, n]));
  const parents = linker();
  const children = linker();
  const partners = linker();
  const siblings = new Map<string, readonly string[]>();
  const groupParents = new Map<string, string[]>();
  const groupChildren = linker();

  for (const edge of layout.edges) {
    if (edge.kind === 'couple' && edge.parents?.length === 2) {
      const [a, b] = edge.parents as [string, string];
      partners.push(a, b);
      partners.push(b, a);
    } else if (edge.kind === 'parent-child') {
      if (edge.parents) groupParents.set(edge.group, edge.parents);
      if (edge.child) groupChildren.push(edge.group, edge.child);
    }
  }
  for (const [group, kids] of groupChildren.lists) {
    const ps = groupParents.get(group) ?? [];
    for (const kid of kids) {
      for (const p of ps) {
        parents.push(kid, p);
        children.push(p, kid);
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

/** Kinship path steps: U(p), D(own), S(pouse), B(rother or sister). */
function kinshipPaths(rel: Relations, focusKey: string, stopAt?: string): Map<string, string> {
  const paths = new Map<string, string>([[focusKey, '']]);
  // Sibling lists are shared by the whole group: the first member to reach one
  // (the nearest, as the walk is breadth-first) labels all the others.
  const walked = new Set<readonly string[]>();
  let frontier = [focusKey];
  while (frontier.length > 0 && !(stopAt && paths.has(stopAt))) {
    const next: string[] = [];
    for (const from of frontier) {
      const path = paths.get(from)!;
      if (path.length >= 4) continue;
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
          paths.set(to, path + step);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return paths;
}

function term(path: string, sex: Sex, half: boolean): string | null {
  if (/^U+$/.test(path)) return ancestorTerm(path.length, sex);
  if (/^D+$/.test(path)) return descendantTerm(path.length, sex);
  const h = half ? 'half-' : '';
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
  return path ? term(path, sexOf(key), rel.nodes.get(key)?.isHalfSibling === true) : null;
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
    if (!path) continue;
    const label = term(path, sexOf(key), rel.nodes.get(key)?.isHalfSibling === true);
    if (label) labels[key] = label;
  }
  return labels;
}
