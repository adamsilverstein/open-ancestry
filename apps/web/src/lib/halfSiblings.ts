import type { ApiPersonSummary, PersonDetail } from '../api/types';

/** Ids of the person's parents across all their parent families. */
export function parentIds(detail: PersonDetail): string[] {
  const ids = detail.parentFamilies.flatMap((f) => [f.partner1?.id, f.partner2?.id]);
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/**
 * Children of the parents' other partnerships: half siblings, which the
 * person's own detail does not include. Takes the parents' details.
 */
export function halfSiblings(detail: PersonDetail, parents: PersonDetail[]): ApiPersonSummary[] {
  const ownFamilies = new Set(detail.parentFamilies.map((f) => f.family.id));
  const known = new Set([
    detail.person.id,
    ...detail.parentFamilies.flatMap((f) => f.siblings.map((s) => s.person.id)),
  ]);
  const found: ApiPersonSummary[] = [];
  for (const parent of parents) {
    for (const { family, children } of parent.partnerFamilies) {
      if (ownFamilies.has(family.id)) continue;
      for (const { person } of children) {
        if (known.has(person.id)) continue;
        known.add(person.id);
        found.push(person);
      }
    }
  }
  return found;
}
