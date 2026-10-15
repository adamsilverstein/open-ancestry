import {
  bySex,
  childWord,
  isBirthParent,
  isParent,
  parentLink,
  parentWord,
  siblingKind as coreSiblingKind,
  siblingWord,
} from '@open-ancestry/core';
import type { SiblingKind } from '@open-ancestry/core';
import type { ChildRelationship, FamilyChildRow, FamilyRow } from '@open-ancestry/db';
import type { ApiPersonSummary, ParentFamily } from '../api/types';

/*
 * Kinship over a person detail's families: which siblings are full, half,
 * step or foster, and how parents and children are linked. The rules and
 * words come from core's `kin` module, which the tree labels and the
 * relationship calculator share.
 */

export { bySex, childWord, parentLink, parentWord, siblingWord };
export type { SiblingKind };

type Rels = Pick<FamilyChildRow, 'partner1_rel' | 'partner2_rel'>;

/** Birth or adoption: a parent. Step, foster, guardian and related links are not. */
export const isParentLink = (rel: ChildRelationship) => isParent(rel);

/** Birth parenthood, as opposed to adoption, step, foster or guardian care. */
export const isBirthLink = (rel: ChildRelationship) => isBirthParent(rel);

/** How two children of one family are siblings, from their links to its partners. */
export function siblingKind(
  family: Pick<ParentFamily, 'partner1' | 'partner2'>,
  mine: Rels,
  theirs: Rels,
): SiblingKind {
  const shared: [ChildRelationship, ChildRelationship][] = [];
  if (family.partner1) shared.push([mine.partner1_rel, theirs.partner1_rel]);
  if (family.partner2) shared.push([mine.partner2_rel, theirs.partner2_rel]);
  return coreSiblingKind(shared);
}

const CLOSENESS: Record<SiblingKind, number> = { full: 0, half: 1, adopted: 2, step: 3, foster: 4 };

export interface Sibling {
  person: ApiPersonSummary;
  kind: SiblingKind;
}

/** Each sibling once, with the closest kind found (a full sibling also adopted elsewhere stays full). */
export function closest(siblings: Iterable<Sibling>): Sibling[] {
  const found = new Map<string, Sibling>();
  for (const sibling of siblings) {
    const known = found.get(sibling.person.id);
    if (!known || CLOSENESS[sibling.kind] < CLOSENESS[known.kind]) {
      found.set(sibling.person.id, sibling);
    }
  }
  return [...found.values()];
}

/** Siblings across all parent families. */
export function siblingsOf(parentFamilies: ParentFamily[]): Sibling[] {
  return closest(
    parentFamilies.flatMap((family) =>
      family.siblings.map((s) => ({
        person: s.person,
        kind: siblingKind(family, family.link, s.link),
      })),
    ),
  );
}

/** The link between `personId` (a partner of `family`) and a child of the family. */
export function linkToPartner(
  family: Pick<FamilyRow, 'partner1_id'>,
  personId: string,
  link: Rels,
): ChildRelationship {
  return family.partner1_id === personId ? link.partner1_rel : link.partner2_rel;
}

/** The link between a child and the partner other than `personId`. */
export function linkToOtherPartner(
  family: Pick<FamilyRow, 'partner1_id'>,
  personId: string,
  link: Rels,
): ChildRelationship {
  return family.partner1_id === personId ? link.partner2_rel : link.partner1_rel;
}
