/** Lookups over a `TreeGraph` slice, tolerant of dangling ids and self-references. */
import type { ChildRelation, TreeFamily, TreeGraph, TreePerson } from './types';

export interface GraphIndex {
  person(id: string): TreePerson | undefined;
  /** Families in which `id` is a child, in graph order. */
  parentFamilies(id: string): readonly TreeFamily[];
  /** Families in which `id` is a partner and that have a spouse or a child, in graph order. */
  partnerFamilies(id: string): readonly TreeFamily[];
  /** Both partners, absent or repeated ones as null. */
  partners(family: TreeFamily): [string | null, string | null];
  /** Children present in the slice, without repeats. */
  children(family: TreeFamily): string[];
}

const NONE: readonly TreeFamily[] = [];

export function indexGraph(graph: TreeGraph): GraphIndex {
  const people: ReadonlyMap<string, TreePerson> =
    graph.people instanceof Map ? graph.people : new Map(Object.entries(graph.people));
  const asChild = new Map<string, TreeFamily[]>();
  const asPartner = new Map<string, TreeFamily[]>();
  const partnerCache = new Map<TreeFamily, [string | null, string | null]>();
  const childCache = new Map<TreeFamily, string[]>();
  const push = (map: Map<string, TreeFamily[]>, id: string, family: TreeFamily) => {
    const list = map.get(id);
    if (list) list.push(family);
    else map.set(id, [family]);
  };

  for (const family of graph.families) {
    const [a, b] = family.partners;
    const p1 = a != null && people.has(a) ? a : null;
    const p2 = b != null && b !== p1 && people.has(b) ? b : null;
    const partners: [string | null, string | null] = [p1, p2];
    const children = [...new Set(family.children.map((c) => c.id))].filter((id) => people.has(id));
    partnerCache.set(family, partners);
    childCache.set(family, children);
    for (const id of children) push(asChild, id, family);
    if (p1 && (p2 || children.length)) push(asPartner, p1, family);
    if (p2 && (p1 || children.length)) push(asPartner, p2, family);
  }

  return {
    person: (id) => people.get(id),
    parentFamilies: (id) => asChild.get(id) ?? NONE,
    partnerFamilies: (id) => asPartner.get(id) ?? NONE,
    partners: (family) => partnerCache.get(family)!,
    children: (family) => childCache.get(family)!,
  };
}

const RANK: Record<ChildRelation, number> = {
  unknown: 0,
  biological: 1,
  adopted: 2,
  step: 2,
  foster: 2,
  related: 2,
  guardian: 2,
  private: 2,
};

/** Single relation for drawing: the most specific of the two, so an adoption is never hidden. */
export function childRelation(family: TreeFamily, childId: string): ChildRelation {
  const entry = family.children.find((c) => c.id === childId);
  const r1 = entry?.rel1 ?? 'unknown';
  const r2 = entry?.rel2 ?? 'unknown';
  return RANK[r2] > RANK[r1] ? r2 : r1;
}

const PREFERENCE: Record<ChildRelation, number> = {
  biological: 3,
  unknown: 2,
  adopted: 1,
  step: 1,
  foster: 1,
  related: 1,
  guardian: 1,
  private: 1,
};

/**
 * The parent set to draw: the switcher's choice, else the most biological
 * family (both partners' relations scored), ties going to graph order.
 */
export function chooseParentFamily(
  index: GraphIndex,
  personId: string,
  selected: Readonly<Record<string, string>>,
): TreeFamily | undefined {
  const families = index.parentFamilies(personId).filter((f) => {
    const [a, b] = index.partners(f);
    return a !== null || b !== null;
  });
  const wanted = Object.hasOwn(selected, personId) ? selected[personId] : undefined;
  const chosen = families.find((f) => f.id === wanted);
  if (chosen) return chosen;
  let best: TreeFamily | undefined;
  let bestScore = -1;
  for (const family of families) {
    const entry = family.children.find((c) => c.id === personId);
    const score = PREFERENCE[entry?.rel1 ?? 'unknown'] + PREFERENCE[entry?.rel2 ?? 'unknown'];
    if (score > bestScore) {
      best = family;
      bestScore = score;
    }
  }
  return best;
}

/** Partners left to right (or top to bottom): father first when the sexes say so. */
export function coupleOrder(index: GraphIndex, family: TreeFamily): string[] {
  const [a, b] = index.partners(family);
  const ids = [a, b].filter((id) => id !== null);
  if (ids.length === 2 && index.person(a!)!.sex === 'F' && index.person(b!)!.sex === 'M') {
    ids.reverse();
  }
  return ids;
}

export function spouseOf(index: GraphIndex, family: TreeFamily, personId: string): string | null {
  const [a, b] = index.partners(family);
  return a === personId ? b : a;
}
