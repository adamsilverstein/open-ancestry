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
  siblings: Map<string, string[]>;
  /** Cards sharing a row, left to right. */
  rows: Map<string, LayoutNode[]>;
}

export type Direction = 'up' | 'down' | 'left' | 'right';
type Sex = 'M' | 'F' | 'U' | 'X';

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

const rowKey = (n: LayoutNode) => `${n.generation}:${n.y}`;

export function buildRelations(layout: TreeLayout): Relations {
  const nodes = new Map(layout.nodes.map((n) => [n.key, n]));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const partners = new Map<string, string[]>();
  const siblings = new Map<string, string[]>();
  const groupParents = new Map<string, string[]>();
  const groupChildren = new Map<string, string[]>();

  for (const edge of layout.edges) {
    if (edge.kind === 'couple' && edge.parents?.length === 2) {
      const [a, b] = edge.parents as [string, string];
      push(partners, a, b);
      push(partners, b, a);
    } else if (edge.kind === 'parent-child') {
      if (edge.parents) groupParents.set(edge.group, edge.parents);
      if (edge.child) push(groupChildren, edge.group, edge.child);
    }
  }
  for (const [group, kids] of groupChildren) {
    const ps = groupParents.get(group) ?? [];
    for (const kid of kids) {
      for (const p of ps) {
        push(parents, kid, p);
        push(children, p, kid);
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

  return { nodes, parents, children, partners, siblings, rows };
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
  // Breadth-first over U(p), D(own), S(pouse) and B(rother/sister) steps.
  const paths = new Map<string, string>([[focusKey, '']]);
  let frontier = [focusKey];
  while (frontier.length > 0 && !paths.has(key)) {
    const next: string[] = [];
    for (const from of frontier) {
      const path = paths.get(from)!;
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
          paths.set(to, path + step);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  const path = paths.get(key);
  if (!path) return null;
  const sex = sexOf(key);
  const normalized = path.replace('UD', 'B');
  if (/^U+$/.test(path)) return ancestorTerm(path.length, sex);
  if (/^D+$/.test(path)) return descendantTerm(path.length, sex);
  const half = rel.nodes.get(key)?.isHalfSibling ? 'half-' : '';
  switch (normalized) {
    case 'S':
      return gendered(sex, 'husband', 'wife', 'spouse');
    case 'B':
      return half + gendered(sex, 'brother', 'sister', 'sibling');
    case 'UB':
    case 'UBS':
      return half + gendered(sex, 'uncle', 'aunt', 'parent’s sibling');
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
