/** English kinship terms, gendered by the sex of the person being named. */
import type { PartnerRelationship, Sex } from '../layout/types';

/** A non-biological link on the path that changes the name. */
export type Modifier = 'step' | 'adopted' | 'foster' | undefined;

export const APOSTROPHE = '’s ';

const pick = (sex: Sex | undefined, male: string, female: string, neutral: string) =>
  sex === 'M' ? male : sex === 'F' ? female : neutral;

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** 0 "", 1 "great-", 2 "2nd great-"... */
const greats = (n: number) => (n === 0 ? '' : n === 1 ? 'great-' : `${ordinal(n)} great-`);

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** Generations from the common ancestor: `up` from A, `down` to B. */
export type Shape = { up: number; down: number };

export const isAncestor = ({ up, down }: Shape) => up === 0 && down > 0;
export const isDescendant = ({ up, down }: Shape) => down === 0 && up > 0;
export const isSibling = ({ up, down }: Shape) => up === 1 && down === 1;
export const isAuntOrUncle = ({ up, down }: Shape) => up === 1 && down >= 2;
export const isNieceOrNephew = ({ up, down }: Shape) => up >= 2 && down === 1;
export const isCousin = ({ up, down }: Shape) => up >= 2 && down >= 2;

export function ancestorWord(generations: number, sex: Sex | undefined): string {
  if (generations === 1) return pick(sex, 'father', 'mother', 'parent');
  return greats(generations - 2) + pick(sex, 'grandfather', 'grandmother', 'grandparent');
}

export function descendantWord(generations: number, sex: Sex | undefined): string {
  if (generations === 1) return pick(sex, 'son', 'daughter', 'child');
  return greats(generations - 2) + pick(sex, 'grandson', 'granddaughter', 'grandchild');
}

/** 2 aunt, 3 great-aunt, 4 great-grandaunt, 5 2nd great-grandaunt. */
function collateral(levels: number, word: string): string {
  if (levels === 0) return word;
  if (levels === 1) return `great-${word}`;
  return `${greats(levels - 1)}grand${word}`;
}

export function auntWord(down: number, sex: Sex | undefined): string {
  return collateral(down - 2, pick(sex, 'uncle', 'aunt', 'aunt or uncle'));
}

export function nieceWord(up: number, sex: Sex | undefined): string {
  return collateral(up - 2, pick(sex, 'nephew', 'niece', 'niece or nephew'));
}

/** What A is to B for a blood shape, with "half", step, adoptive or foster wording. */
export function bloodName(
  shape: Shape,
  sex: Sex | undefined,
  half = false,
  modifier: Modifier = undefined,
): string {
  const { up, down } = shape;
  if (up === 0 && down === 0) return 'self';
  let word: string;
  if (isAncestor(shape)) word = ancestorWord(down, sex);
  else if (isDescendant(shape)) word = descendantWord(up, sex);
  else if (isSibling(shape)) word = pick(sex, 'brother', 'sister', 'sibling');
  else if (isAuntOrUncle(shape)) word = auntWord(down, sex);
  else if (isNieceOrNephew(shape)) word = nieceWord(up, sex);
  else {
    const removed = Math.abs(up - down);
    word = `${ordinal(Math.min(up, down) - 1)} cousin`;
    if (removed) word += ` ${times(removed)} removed`;
  }
  if (modifier === 'step') {
    // stepfather, stepson, stepbrother; step-grandmother, step-aunt.
    const simple = (isAncestor(shape) && down === 1) || (isDescendant(shape) && up === 1);
    return simple || isSibling(shape) ? `step${word}` : `step-${word}`;
  }
  if (modifier === 'adopted') return `${isDescendant(shape) ? 'adopted' : 'adoptive'} ${word}`;
  if (modifier === 'foster') return `foster ${word}`;
  if (half) return isCousin(shape) ? `half ${word}` : `half-${word}`;
  return word;
}

export function spouseWord(sex: Sex | undefined, relationship?: PartnerRelationship): string {
  if (relationship === 'partners') return 'partner';
  return pick(sex, 'husband', 'wife', 'spouse');
}

/** A is the spouse of B's relative R, where R is to B as `shape`. */
export function spouseOfRelative(
  shape: Shape,
  relativeName: string,
  sex: Sex | undefined,
  relationship?: PartnerRelationship,
): string {
  if (isAncestor(shape)) {
    return shape.down === 1
      ? `step${ancestorWord(1, sex)}`
      : `step-${ancestorWord(shape.down, sex)}`;
  }
  if (isDescendant(shape)) return `${descendantWord(shape.up, sex)}-in-law`;
  if (isSibling(shape)) return `${pick(sex, 'brother', 'sister', 'sibling')}-in-law`;
  if (isAuntOrUncle(shape)) return `${auntWord(shape.down, sex)} by marriage`;
  if (isNieceOrNephew(shape)) return `${nieceWord(shape.up, sex)} by marriage`;
  return relativeName + APOSTROPHE + spouseWord(sex, relationship);
}

/** A is a relative of B's spouse S, where A is to S as `shape`. */
export function relativeOfSpouse(
  shape: Shape,
  relativeName: string,
  sex: Sex | undefined,
  spouse: string,
): string {
  if (isAncestor(shape)) return `${ancestorWord(shape.down, sex)}-in-law`;
  if (isDescendant(shape)) {
    return shape.up === 1
      ? `step${descendantWord(1, sex)}`
      : `step-${descendantWord(shape.up, sex)}`;
  }
  if (isSibling(shape)) return `${pick(sex, 'brother', 'sister', 'sibling')}-in-law`;
  return spouse + APOSTROPHE + relativeName;
}

export function stepSiblingWord(sex: Sex | undefined): string {
  return `step${pick(sex, 'brother', 'sister', 'sibling')}`;
}
