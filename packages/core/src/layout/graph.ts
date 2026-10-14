/** Lookups over a `TreeGraph` slice, tolerant of dangling ids and self-references. */
import type { ChildRelation, TreeFamily, TreeFamilyChild, TreeGraph, TreePerson } from './types';

export interface GraphIndex {
  person(id: string): TreePerson | undefined;
  /** Families in which `id` is a child, by the child's `order`, then graph order. */
  parentFamilies(id: string): readonly TreeFamily[];
  /**
   * Families in which `id` is a partner and that have a spouse or a child, by
   * that partner's `partnerOrder`, then graph order.
   */
  partnerFamilies(id: string): readonly TreeFamily[];
  /** Both partners, absent or repeated ones as null. */
  partners(family: TreeFamily): [string | null, string | null];
  /** Children present in the slice, without repeats. */
  children(family: TreeFamily): string[];
  /** The child's entry in the family, found in constant time. */
  entry(family: TreeFamily, childId: string): TreeFamilyChild | undefined;
}

const NONE: readonly TreeFamily[] = [];

interface Indexed {
  partners: [string | null, string | null];
  children: string[];
  entries: Map<string, TreeFamilyChild>;
}

export function indexGraph(graph: TreeGraph): GraphIndex {
  const people: ReadonlyMap<string, TreePerson> =
    graph.people instanceof Map ? graph.people : new Map(Object.entries(graph.people));
  const asChild = new Map<string, { family: TreeFamily; order: number }[]>();
  const asPartner = new Map<string, { family: TreeFamily; order: number }[]>();
  const indexed = new Map<TreeFamily, Indexed>();
  const push = (
    map: Map<string, { family: TreeFamily; order: number }[]>,
    id: string,
    family: TreeFamily,
    order = 0,
  ) => {
    const list = map.get(id);
    if (list) list.push({ family, order });
    else map.set(id, [{ family, order }]);
  };

  for (const family of graph.families) {
    const [a, b] = family.partners;
    const p1 = a != null && people.has(a) ? a : null;
    const p2 = b != null && b !== p1 && people.has(b) ? b : null;
    const entries = new Map<string, TreeFamilyChild>();
    for (const child of family.children) {
      if (people.has(child.id) && !entries.has(child.id)) entries.set(child.id, child);
    }
    const children = [...entries.keys()];
    indexed.set(family, { partners: [p1, p2], children, entries });
    for (const child of entries.values()) push(asChild, child.id, family, child.order);
    const [o1, o2] = family.partnerOrder ?? [0, 0];
    if (p1 && (p2 || children.length)) push(asPartner, p1, family, o1);
    if (p2 && (p1 || children.length)) push(asPartner, p2, family, o2);
  }
  // Stable sort keeps graph order for equal (or missing) orders.
  const sorted = (map: Map<string, { family: TreeFamily; order: number }[]>) =>
    new Map(
      [...map].map(([id, list]) => [
        id,
        list.sort((x, y) => x.order - y.order).map((x) => x.family),
      ]),
    );
  const parents = sorted(asChild);
  const partnerOf = sorted(asPartner);

  return {
    person: (id) => people.get(id),
    parentFamilies: (id) => parents.get(id) ?? NONE,
    partnerFamilies: (id) => partnerOf.get(id) ?? NONE,
    partners: (family) => indexed.get(family)!.partners,
    children: (family) => indexed.get(family)!.children,
    entry: (family, childId) => indexed.get(family)!.entries.get(childId),
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
export function childRelation(
  index: GraphIndex,
  family: TreeFamily,
  childId: string,
): ChildRelation {
  const entry = index.entry(family, childId);
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
 * The parent set to draw: the switcher's choice, else the family marked
 * `preferred` (GEDCOM/Ancestry preferred parents), else the most biological
 * family (both partners' relations scored), ties going to the first.
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
    const entry = index.entry(family, personId);
    const score =
      (entry?.preferred ? 100 : 0) +
      PREFERENCE[entry?.rel1 ?? 'unknown'] +
      PREFERENCE[entry?.rel2 ?? 'unknown'];
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
