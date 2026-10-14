import type { ChildRelationship, FamilyChildRow, FamilyRow } from '@open-ancestry/db';
import type { ApiPersonSummary, ParentFamily } from '../api/types';

/*
 * Kinship words for family members listed in a person detail: half and step
 * siblings, step and adoptive parents and children. Shared by the timeline,
 * the Relationships column and LifeStory, so they always agree.
 */

type Rels = Pick<FamilyChildRow, 'partner1_rel' | 'partner2_rel'>;

/** Step, foster and guardian links do not make someone a parent; adoption does. */
const NOT_PARENT = new Set<ChildRelationship>(['step', 'foster', 'guardian']);

export const isParentLink = (rel: ChildRelationship) => !NOT_PARENT.has(rel);

/** Biological (or unrecorded) parenthood, as opposed to adoption, step or foster care. */
export const isBirthLink = (rel: ChildRelationship) => isParentLink(rel) && rel !== 'adopted';

/** `he`/`she`/neutral word by sex. */
export function bySex(sex: string, male: string, female: string, other: string): string {
  return sex === 'M' ? male : sex === 'F' ? female : other;
}

export type SiblingKind = 'full' | 'half' | 'step';

/**
 * How two children of one family are related: full when they share every
 * recorded partner as a parent, half when they share one, step when they
 * share none (each is the other's parent's stepchild).
 */
export function siblingKind(
  family: Pick<ParentFamily, 'partner1' | 'partner2'>,
  mine: Rels,
  theirs: Rels,
): SiblingKind {
  let present = 0;
  let shared = 0;
  const sides = [
    [family.partner1, mine.partner1_rel, theirs.partner1_rel],
    [family.partner2, mine.partner2_rel, theirs.partner2_rel],
  ] as const;
  for (const [partner, a, b] of sides) {
    if (!partner) continue;
    present++;
    if (isParentLink(a) && isParentLink(b)) shared++;
  }
  return shared === present ? 'full' : shared === 0 ? 'step' : 'half';
}

const CLOSENESS: Record<SiblingKind, number> = { full: 0, half: 1, step: 2 };

/** `half-sister`, `stepbrother`, `sibling`. */
export function siblingWord(sex: string, kind: SiblingKind): string {
  const base = bySex(sex, 'brother', 'sister', 'sibling');
  return kind === 'full' ? base : kind === 'half' ? `half-${base}` : `step${base}`;
}

export interface Sibling {
  person: ApiPersonSummary;
  kind: SiblingKind;
}

/**
 * Siblings across all parent families, each once with the closest kind (a
 * full sibling also listed in an adoptive family stays full).
 */
export function siblingsOf(parentFamilies: ParentFamily[]): Sibling[] {
  const found = new Map<string, Sibling>();
  for (const family of parentFamilies) {
    for (const sibling of family.siblings) {
      const kind = siblingKind(family, family.link, sibling.link);
      const known = found.get(sibling.person.id);
      if (!known || CLOSENESS[kind] < CLOSENESS[known.kind]) {
        found.set(sibling.person.id, { person: sibling.person, kind });
      }
    }
  }
  return [...found.values()];
}

/** `stepfather`, `adoptive mother`; plain for biological or unknown links. */
export function parentWord(sex: string, rel: ChildRelationship): string {
  const base = bySex(sex, 'father', 'mother', 'parent');
  if (rel === 'step') return `step${base}`;
  if (rel === 'adopted') return `adoptive ${base}`;
  if (rel === 'foster') return `foster ${base}`;
  return base;
}

/** `stepson`, `adopted daughter`; plain for biological or unknown links. */
export function childWord(sex: string, rel: ChildRelationship): string {
  const base = bySex(sex, 'son', 'daughter', 'child');
  if (rel === 'step') return `step${base}`;
  if (rel === 'adopted') return `adopted ${base}`;
  if (rel === 'foster') return `foster ${base}`;
  return base;
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
