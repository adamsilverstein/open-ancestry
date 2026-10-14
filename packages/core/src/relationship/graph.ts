/** `KinshipGraph` over a `TreeGraph`, for the web worker and for tests. */
import { indexGraph, spouseOf } from '../layout/graph';
import type { TreeFamily, TreeGraph } from '../layout/types';
import type { KinshipGraph, ParentEdge, PartnerEdge } from './types';

/**
 * A family with children but no recorded partners (a GEDCOM `FAM` with only
 * `CHIL` lines) still makes its children siblings. It stands in as their one
 * shared parent under this id prefix, which shows up in paths and common
 * ancestors.
 */
export const VIRTUAL_PARENT = 'family:';

export const isVirtualParent = (id: string) => id.startsWith(VIRTUAL_PARENT);

/**
 * Wraps a graph slice. On the server, build the `TreeGraph` from the family
 * and family_child rows (or `fromNeighborhood(getNeighborhood(...))` for a
 * bounded slice) and pass it here.
 */
export function kinshipGraph(graph: TreeGraph): KinshipGraph {
  const index = indexGraph(graph);
  const byId = new Map<string, TreeFamily>(graph.families.map((f) => [f.id, f]));
  const memo = <T>(fn: (id: string) => T) => {
    const cache = new Map<string, T>();
    return (id: string) => {
      let value = cache.get(id);
      if (value === undefined) {
        value = fn(id);
        cache.set(id, value);
      }
      return value;
    };
  };
  return {
    sex: (id) => index.person(id)?.sex,
    parents: memo((id): ParentEdge[] =>
      index.parentFamilies(id).flatMap((family) => {
        const entry = index.entry(family, id);
        const [p1, p2] = index.partners(family);
        const edges: ParentEdge[] = [];
        if (p1) edges.push({ id: p1, familyId: family.id, rel: entry?.rel1 ?? 'unknown' });
        if (p2) edges.push({ id: p2, familyId: family.id, rel: entry?.rel2 ?? 'unknown' });
        if (!p1 && !p2) {
          edges.push({ id: VIRTUAL_PARENT + family.id, familyId: family.id, rel: 'unknown' });
        }
        return edges;
      }),
    ),
    children: memo((id): ParentEdge[] => {
      if (isVirtualParent(id)) {
        const family = byId.get(id.slice(VIRTUAL_PARENT.length));
        if (!family) return [];
        return index.children(family).map((child) => ({
          id: child,
          familyId: family.id,
          rel: 'unknown',
        }));
      }
      return index.partnerFamilies(id).flatMap((family) => {
        const first = index.partners(family)[0] === id;
        return index.children(family).map((child) => {
          const entry = index.entry(family, child);
          const rel = (first ? entry?.rel1 : entry?.rel2) ?? 'unknown';
          return { id: child, familyId: family.id, rel };
        });
      });
    }),
    partners: memo((id): PartnerEdge[] =>
      index.partnerFamilies(id).flatMap((family) => {
        const spouse = spouseOf(index, family, id);
        if (spouse === null) return [];
        const edge: PartnerEdge = { id: spouse, familyId: family.id };
        if (family.relationship) edge.relationship = family.relationship;
        return [edge];
      }),
    ),
  };
}
