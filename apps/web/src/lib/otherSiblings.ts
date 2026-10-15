import { siblingKind } from '@open-ancestry/core';
import type { PersonDetail } from '../api/types';
import { closest, linkToPartner, type Sibling } from './kin';

/** Ids of the person's parents across all their parent families. */
export function parentIds(detail: PersonDetail): string[] {
  const ids = detail.parentFamilies.flatMap((f) => [f.partner1?.id, f.partner2?.id]);
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/**
 * Children of the parents' other partnerships, which the person's own detail
 * does not include. Each is a half-sibling only when both are children (birth
 * or adoptive) of that parent; a parent's stepchild there is a step-sibling,
 * and foster or guardian care makes a foster sibling. Takes the parents'
 * details.
 */
export function otherSiblings(detail: PersonDetail, parents: PersonDetail[]): Sibling[] {
  const ownFamilies = new Set(detail.parentFamilies.map((f) => f.family.id));
  const known = new Set([
    detail.person.id,
    ...detail.parentFamilies.flatMap((f) => f.siblings.map((s) => s.person.id)),
  ]);
  // My link to each parent, through the family I share with them.
  const mine = new Map<string, ReturnType<typeof linkToPartner>>();
  for (const f of detail.parentFamilies) {
    if (f.partner1 && !mine.has(f.partner1.id)) mine.set(f.partner1.id, f.link.partner1_rel);
    if (f.partner2 && !mine.has(f.partner2.id)) mine.set(f.partner2.id, f.link.partner2_rel);
  }
  const found: Sibling[] = [];
  for (const parent of parents) {
    const myLink = mine.get(parent.person.id) ?? 'unknown';
    for (const { family, children } of parent.partnerFamilies) {
      if (ownFamilies.has(family.id)) continue;
      for (const { person, link } of children) {
        if (known.has(person.id)) continue;
        const theirs = linkToPartner(family, parent.person.id, link);
        found.push({ person, kind: siblingKind([[myLink, theirs]], true) });
      }
    }
  }
  return closest(found);
}
