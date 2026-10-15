/**
 * The relationship term for a tree card, from the path the layout already
 * walked from the focus person to the card. It uses the same rules and words
 * as the relationship calculator (core `kin` and `names`), so a card and the
 * calculator never call one person two different things.
 */
import { childWord, lineQualifier, parentLink, parentWord, siblingKind } from '../kin';
import type { SharedAdult, SiblingKind } from '../kin';
import type { ChildRelation, PartnerRelationship, Sex } from '../layout/types';
import {
  bloodName,
  chain,
  relativeOfSpouse,
  spouseOfRelative,
  spouseWord,
  type NameStyle,
  type Shape,
} from './names';

/**
 * One step from the focus person towards the card. `sex` is the sex of the
 * person the step reaches, when the layout knows it.
 *
 * - `U`: up to a parent; `rel` is the child's link to that parent.
 * - `D`: down to a child; `rel` is that child's link to this parent.
 * - `S`: to a partner.
 * - `B`: to a sibling. Give their `kind`, or `shared` ([mine, theirs] links to
 *   each adult joining them) and `apart` as for core `siblingKind`.
 */
export type CardStep =
  | { step: 'U' | 'D'; rel?: ChildRelation; sex?: Sex }
  | { step: 'S'; relationship?: PartnerRelationship; sex?: Sex }
  | { step: 'B'; kind?: SiblingKind; shared?: SharedAdult[]; apart?: boolean; sex?: Sex };

type BloodStep = Exclude<CardStep, { step: 'S' }>;
type LineStep = Extract<CardStep, { step: 'U' | 'D' }>;
const isLine =
  (step: 'U' | 'D') =>
  (s: BloodStep): s is LineStep =>
    s.step === step;

const SIBLING_REL: Partial<Record<SiblingKind, ChildRelation>> = {
  adopted: 'adopted',
  step: 'step',
  foster: 'foster',
};

/** What the last person of a blood run is to its first, or undefined for an odd shape. */
function bloodTerm(run: BloodStep[], sex: Sex | undefined, style: NameStyle): string | undefined {
  // Up, then at most one sibling step, then down: the shapes kinship names describe.
  const order = run.map((s) => s.step).join('');
  if (!/^U*B?D*$/.test(order)) return undefined;
  const ups = run.filter(isLine('U'));
  const downs = run.filter(isLine('D'));
  const sibling = run.find((s) => s.step === 'B') as Extract<BloodStep, { step: 'B' }> | undefined;
  const kind = sibling
    ? (sibling.kind ?? siblingKind(sibling.shared ?? [], sibling.apart ?? false))
    : undefined;

  // A guardian is named as such directly; further out, care reads as foster.
  const only = run.length === 1 ? run[0]! : undefined;
  if (only && only.step !== 'B' && parentLink(only.rel) === 'guardian') {
    return only.step === 'U' ? parentWord(sex, 'guardian') : childWord(sex, 'guardian');
  }

  // The card's person is A: up from A is the downs (plus the sibling step), down to the focus the ups.
  const shape: Shape = {
    up: downs.length + (sibling ? 1 : 0),
    down: ups.length + (sibling ? 1 : 0),
  };
  const rels = [...ups, ...downs].map((s) => s.rel);
  const siblingRel = kind ? SIBLING_REL[kind] : undefined;
  if (siblingRel) rels.push(siblingRel);
  // "adopted son" when the adoption is on the card's side, "adoptive father" on the focus side.
  const adoptedBelow = downs.some((s) => parentLink(s.rel) === 'adoptive') || kind === 'adopted';
  const qualifier = lineQualifier(rels, adoptedBelow ? 'adopted' : 'adoptive');
  return bloodName(shape, sex, kind === 'half' && !qualifier, qualifier, style);
}

/**
 * What the card's person (of `sex`) is to the focus person, along `path`
 * from the focus to the card: "step-aunt", "half first cousin", "adopted
 * brother", "sister-in-law", "wife of uncle". Undefined for the focus person
 * itself or a path shape kinship terms do not cover.
 */
export function cardTerm(
  path: readonly CardStep[],
  sex: Sex | undefined,
  style: NameStyle = 'ancestry',
): string | undefined {
  if (path.length === 0) return undefined;
  // Blood runs between partner steps, nearest the focus first.
  const runs: BloodStep[][] = [[]];
  const partners: Extract<CardStep, { step: 'S' }>[] = [];
  for (const step of path) {
    if (step.step === 'S') {
      partners.push(step);
      runs.push([]);
    } else runs.at(-1)!.push(step);
  }
  // The sex of the person each run ends at (the card's for the last one).
  const endSex = (i: number) =>
    i === runs.length - 1 ? sex : (runs[i]!.at(-1)?.sex ?? partners[i - 1]?.sex);
  const names = runs.map((run, i) => (run.length ? bloodTerm(run, endSex(i), style) : ''));
  if (names.some((n) => n === undefined)) return undefined;
  if (partners.length === 0) return names[0];

  const shapeOf = (run: BloodStep[]): Shape => {
    const ups = run.filter((s) => s.step === 'U').length;
    const downs = run.filter((s) => s.step === 'D').length;
    const b = run.some((s) => s.step === 'B') ? 1 : 0;
    return { up: downs + b, down: ups + b };
  };
  if (partners.length === 1) {
    const [near, far] = runs as [BloodStep[], BloodStep[]];
    const partner = partners[0]!;
    // The card's person is a relative of the focus person's partner: sister-in-law, stepson.
    if (!near.length && far.length) {
      const spouse = spouseWord(partner.sex, partner.relationship);
      return relativeOfSpouse(shapeOf(far), names[1]!, sex, spouse, style);
    }
    // The card's person is the partner of the focus person's relative: daughter-in-law, wife of uncle.
    if (near.length && !far.length) {
      return spouseOfRelative(shapeOf(near), names[0]!, sex, partner.relationship, style);
    }
    if (!near.length && !far.length) return spouseWord(sex, partner.relationship);
  }
  // Longer chains, read outward from the focus: "sister of wife of uncle".
  const words: string[] = [];
  runs.forEach((run, i) => {
    if (run.length) words.push(names[i]!);
    const partner = partners[i];
    if (partner) {
      const partnerSex = i === runs.length - 2 && !runs.at(-1)!.length ? sex : partner.sex;
      words.push(spouseWord(partnerSex, partner.relationship));
    }
  });
  return chain(words, style);
}
