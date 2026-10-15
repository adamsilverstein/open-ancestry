/**
 * One definition of kinship links and their words, shared by the person page,
 * the tree card labels and the relationship calculator, so they never call
 * the same two people different things.
 *
 * A child's link to one parent of a family (`ChildRelation`, from GEDCOM
 * `PEDI` and Ancestry's `_FREL`/`_MREL`) is one of:
 *
 * | link                                   | kind       | a parent? |
 * | -------------------------------------- | ---------- | --------- |
 * | biological, unknown, private           | `birth`    | yes       |
 * | adopted                                | `adoptive` | yes       |
 * | step                                   | `step`     | no        |
 * | foster                                 | `foster`   | no        |
 * | guardian, related (a relative raising) | `guardian` | no        |
 *
 * `private` hides the detail, not the parenthood, so it counts as birth.
 */
import type { ChildRelation } from '../layout/types';

export type ParentLink = 'birth' | 'adoptive' | 'step' | 'foster' | 'guardian';

export function parentLink(rel: ChildRelation | null | undefined): ParentLink {
  switch (rel) {
    case 'adopted':
      return 'adoptive';
    case 'step':
      return 'step';
    case 'foster':
      return 'foster';
    case 'guardian':
    case 'related':
      return 'guardian';
    default:
      return 'birth';
  }
}

/** Birth and adoption make someone a parent; step, foster and guardian links do not. */
export const isParent = (rel: ChildRelation | null | undefined) => {
  const link = parentLink(rel);
  return link === 'birth' || link === 'adoptive';
};

export const isBirthParent = (rel: ChildRelation | null | undefined) => parentLink(rel) === 'birth';

/** Care without parenthood: foster parents, guardians, relatives raising a child. */
const isCare = (rel: ChildRelation | null | undefined) => {
  const link = parentLink(rel);
  return link === 'foster' || link === 'guardian';
};

export type SiblingKind = 'full' | 'half' | 'adopted' | 'step' | 'foster';

/** One adult both children are linked to: [my link to them, their link to them]. */
export type SharedAdult = readonly [mine: ChildRelation, theirs: ChildRelation];

/**
 * How two children are siblings, from the adults linking them:
 *
 * - `full`: both are birth children of every shared adult, and `apart` is
 *   false.
 * - `half`: they share some birth parents but not all, or (with `apart`, for
 *   a parent's other partnership) exactly the one parent passed.
 * - `adopted`: they share parents only through adoption (a birth child and
 *   an adopted child of one couple): "adopted brother", as the relationship
 *   calculator says too.
 * - `step`: they share no parent; a parent of one is the partner of a parent
 *   of the other (the stepfather's own son).
 * - `foster`: they share no parent and foster or guardian care joins them.
 *
 * For two children of one family pass every recorded partner of it (none:
 * full, as for a GEDCOM `FAM` with only children). For a
 * child of one of the person's parents in another partnership pass that one
 * parent with `apart`.
 */
export function siblingKind(shared: readonly SharedAdult[], apart = false): SiblingKind {
  // A family with no recorded partners still makes its children siblings.
  if (shared.length === 0) return 'full';
  const common = shared.filter(([mine, theirs]) => isParent(mine) && isParent(theirs)).length;
  const birth = shared.filter(([mine, theirs]) => isBirthParent(mine) && isBirthParent(theirs));
  if (birth.length > 0) return birth.length === shared.length && !apart ? 'full' : 'half';
  if (common > 0) return 'adopted';
  return shared.some(([mine, theirs]) => isCare(mine) || isCare(theirs)) ? 'foster' : 'step';
}

/** A qualifier on a relationship word, from the links along its path. */
export type KinQualifier = 'half' | 'step' | 'adopted' | 'adoptive' | 'foster';

const SIMPLE = new Set([
  'father',
  'mother',
  'parent',
  'son',
  'daughter',
  'child',
  'brother',
  'sister',
  'sibling',
]);

/**
 * The one spelling of a qualified word: `stepfather`, `step-grandmother`,
 * `step-aunt`, `half-sister`, `half 1st cousin`, `adopted son`, `adoptive
 * mother`, `foster brother`.
 */
export function qualify(word: string, qualifier: KinQualifier | undefined): string {
  switch (qualifier) {
    case 'step':
      return SIMPLE.has(word) ? `step${word}` : `step-${word}`;
    case 'half':
      return /cousin/.test(word) ? `half ${word}` : `half-${word}`;
    case 'adopted':
    case 'adoptive':
    case 'foster':
      return `${qualifier} ${word}`;
    default:
      return word;
  }
}

/**
 * The qualifier a line of parent links gives everyone reached through it: a
 * step link anywhere makes it step (a stepfather's sister is a step-aunt),
 * otherwise foster or guardian care makes it foster, otherwise adoption makes
 * it `adopted` or `adoptive` (pass which, by direction). Birth links only:
 * none.
 */
export function lineQualifier(
  rels: readonly (ChildRelation | null | undefined)[],
  adoption: 'adopted' | 'adoptive' = 'adoptive',
): Exclude<KinQualifier, 'half'> | undefined {
  const links = rels.map(parentLink);
  if (links.includes('step')) return 'step';
  if (links.includes('foster') || links.includes('guardian')) return 'foster';
  if (links.includes('adoptive')) return adoption;
  return undefined;
}

/** A word by sex: `M`, `F`, anything else neutral. */
export function bySex(sex: string | undefined, male: string, female: string, other: string) {
  return sex === 'M' ? male : sex === 'F' ? female : other;
}

/** `stepfather`, `adoptive mother`, `foster parent`, `guardian`; plain for birth links. */
export function parentWord(sex: string | undefined, rel: ChildRelation | null | undefined) {
  const link = parentLink(rel);
  if (link === 'guardian') return 'guardian';
  const base = bySex(sex, 'father', 'mother', 'parent');
  return qualify(base, link === 'birth' ? undefined : link);
}

/** `stepson`, `adopted daughter`, `foster child`, `ward`; plain for birth links. */
export function childWord(sex: string | undefined, rel: ChildRelation | null | undefined) {
  const link = parentLink(rel);
  if (link === 'guardian') return 'ward';
  const base = bySex(sex, 'son', 'daughter', 'child');
  return qualify(base, link === 'birth' ? undefined : link === 'adoptive' ? 'adopted' : link);
}

/** `brother`, `half-sister`, `adopted brother`, `stepbrother`, `foster sibling`. */
export function siblingWord(sex: string | undefined, kind: SiblingKind) {
  const base = bySex(sex, 'brother', 'sister', 'sibling');
  return qualify(base, kind === 'full' ? undefined : kind);
}
