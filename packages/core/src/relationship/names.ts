/**
 * English kinship terms, gendered by the sex of the person being named.
 *
 * Two styles. `ancestry` (the default) matches Ancestry.com, which users
 * compare against: "grand" for one generation past aunts and nieces
 * ("granduncle", "great-grandniece") and "1x removed" for cousins.
 * `formal` uses "great-aunt", "great-nephew" and "once removed".
 */
import type { PartnerRelationship, Sex } from '../layout/types';
import { qualify } from '../kin';

/** A non-biological link on the path that changes the name. */
/** `adopted` when A was adopted on the way, `adoptive` when B's side was. */
export type Modifier = 'step' | 'adopted' | 'adoptive' | 'foster' | undefined;

/**
 * A chain of relationships read outward from B, as a phrase: formal is
 * possessive ("brother’s husband’s sister"), Ancestry reads it back with
 * "of" ("sister of husband of brother").
 */
export function chain(parts: string[], style: NameStyle): string {
  return style === 'ancestry' ? [...parts].reverse().join(' of ') : parts.join('’s ');
}

export type NameStyle = 'ancestry' | 'formal';

const pick = (sex: Sex | undefined, male: string, female: string, neutral: string) =>
  sex === 'M' ? male : sex === 'F' ? female : neutral;

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** 0 "", 1 "great-", 2 "2nd great-"... */
const greats = (n: number) => (n === 0 ? '' : n === 1 ? 'great-' : `${ordinal(n)} great-`);

const removed = (n: number, style: NameStyle) =>
  style === 'ancestry' ? `${n}x` : n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;

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

/**
 * Levels past aunt or niece: 0 aunt, 1 grandaunt (ancestry) or great-aunt
 * (formal), 2 great-grandaunt, 3 2nd great-grandaunt.
 */
function collateral(levels: number, word: string, style: NameStyle): string {
  if (levels === 0) return word;
  if (levels === 1) return style === 'ancestry' ? `grand${word}` : `great-${word}`;
  return `${greats(levels - 1)}grand${word}`;
}

export function auntWord(down: number, sex: Sex | undefined, style: NameStyle): string {
  return collateral(down - 2, pick(sex, 'uncle', 'aunt', 'aunt or uncle'), style);
}

export function nieceWord(up: number, sex: Sex | undefined, style: NameStyle): string {
  return collateral(up - 2, pick(sex, 'nephew', 'niece', 'niece or nephew'), style);
}

/** What A is to B for a blood shape, with "half", step, adoptive or foster wording. */
export function bloodName(
  shape: Shape,
  sex: Sex | undefined,
  half = false,
  modifier: Modifier = undefined,
  style: NameStyle = 'ancestry',
): string {
  const { up, down } = shape;
  if (up === 0 && down === 0) return 'self';
  let word: string;
  if (isAncestor(shape)) word = ancestorWord(down, sex);
  else if (isDescendant(shape)) word = descendantWord(up, sex);
  else if (isSibling(shape)) word = pick(sex, 'brother', 'sister', 'sibling');
  else if (isAuntOrUncle(shape)) word = auntWord(down, sex, style);
  else if (isNieceOrNephew(shape)) word = nieceWord(up, sex, style);
  else {
    const gap = Math.abs(up - down);
    word = `${ordinal(Math.min(up, down) - 1)} cousin`;
    if (gap) word += ` ${removed(gap, style)} removed`;
  }
  // A sibling through adoption is an "adopted brother" from either side.
  const qualifier = modifier === 'adoptive' && isSibling(shape) ? 'adopted' : modifier;
  // stepfather, step-aunt, adopted son, foster sister, half-sister, half 1st cousin.
  return qualify(word, qualifier ?? (half ? 'half' : undefined));
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
  relationship: PartnerRelationship | undefined,
  style: NameStyle,
  /** False when the marriage never overlapped B's life: "husband of mother", not stepfather. */
  step = true,
): string {
  if (isAncestor(shape) && (step || shape.down > 1)) {
    return shape.down === 1
      ? `step${ancestorWord(1, sex)}`
      : `step-${ancestorWord(shape.down, sex)}`;
  }
  if (isDescendant(shape)) return `${descendantWord(shape.up, sex)}-in-law`;
  if (isSibling(shape)) return `${pick(sex, 'brother', 'sister', 'sibling')}-in-law`;
  const spouse = spouseWord(sex, relationship);
  if (style === 'ancestry') return chain([relativeName, spouse], style);
  if (isAuntOrUncle(shape)) return `${auntWord(shape.down, sex, style)} by marriage`;
  if (isNieceOrNephew(shape)) return `${nieceWord(shape.up, sex, style)} by marriage`;
  return chain([relativeName, spouse], style);
}

/** A is a relative of B's spouse S, where A is to S as `shape`. */
export function relativeOfSpouse(
  shape: Shape,
  relativeName: string,
  sex: Sex | undefined,
  spouse: string,
  style: NameStyle,
  /** False when the marriage never overlapped A's life: "daughter of wife", not stepdaughter. */
  step = true,
): string {
  if (isAncestor(shape)) return `${ancestorWord(shape.down, sex)}-in-law`;
  if (isDescendant(shape) && (step || shape.up > 1)) {
    return shape.up === 1
      ? `step${descendantWord(1, sex)}`
      : `step-${descendantWord(shape.up, sex)}`;
  }
  if (isSibling(shape)) return `${pick(sex, 'brother', 'sister', 'sibling')}-in-law`;
  if (style === 'ancestry') return chain([spouse, relativeName], style);
  if (isAuntOrUncle(shape)) return `${auntWord(shape.down, sex, style)} by marriage`;
  if (isNieceOrNephew(shape)) return `${nieceWord(shape.up, sex, style)} by marriage`;
  return chain([spouse, relativeName], style);
}

export function stepSiblingWord(sex: Sex | undefined): string {
  return `step${pick(sex, 'brother', 'sister', 'sibling')}`;
}
