/** `KinshipGraph` over a `TreeGraph`, for the web worker and for tests. */
import { indexGraph, spouseOf } from '../layout/graph';
import type { TreeGraph } from '../layout/types';
import type { KinshipGraph, ParentEdge, PartnerEdge } from './types';

/**
 * Wraps a graph slice. On the server, build the `TreeGraph` from the family
 * and family_child rows (or `fromNeighborhood(getNeighborhood(...))` for a
 * bounded slice) and pass it here.
 */
export function kinshipGraph(graph: TreeGraph): KinshipGraph {
  const index = indexGraph(graph);
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
        return edges;
      }),
    ),
    children: memo((id): ParentEdge[] =>
      index.partnerFamilies(id).flatMap((family) => {
        const first = index.partners(family)[0] === id;
        return index.children(family).map((child) => {
          const entry = index.entry(family, child);
          const rel = (first ? entry?.rel1 : entry?.rel2) ?? 'unknown';
          return { id: child, familyId: family.id, rel };
        });
      }),
    ),
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
