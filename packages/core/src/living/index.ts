/**
 * Living inference, matching Ancestry: a person is living unless they have a
 * death or burial fact or were born `thresholdYears` (100) or more years ago.
 *
 * It fails closed. Only positive evidence makes someone deceased: a death,
 * burial or other death fact (even undated), or a birth year that is at least
 * the threshold ago. Missing, unparseable or open-ended dates (`AFT 1900`),
 * future dates, a bad `today` or malformed input all leave the person living,
 * so their details stay private.
 *
 * Without a usable birth date the birth year is estimated from relatives:
 * parent + 25, spouse + 0, child - 25 years. Every date counts at its latest
 * possible year and the latest estimate wins, again erring toward living.
 * An estimate alone only proves death when it rests on at least two dated
 * relatives and clears the threshold by ESTIMATE_MARGIN_YEARS, so one
 * mistyped relative's date cannot hide a living person's privacy.
 * With no dates at all the person is living, as on Ancestry.
 */
import { parseDate } from '../dates';
import type { DateInput, ParsedDate } from '../dates';

export const GENERATION_YEARS = 25;
export const ESTIMATE_MARGIN_YEARS = 10;

export interface LivingInput {
  birth?: DateInput;
  /** Any death value, even an empty or undated one, means the person died. */
  death?: DateInput;
  burial?: DateInput;
  /** Other death evidence such as cremation, probate or `DEAT Y`. */
  hasDeathFacts?: boolean;
  parentBirths?: DateInput[];
  spouseBirths?: DateInput[];
  childBirths?: DateInput[];
}

export type LivingReason =
  | 'death-facts'
  | 'birth-within-threshold'
  | 'birth-beyond-threshold'
  /** Relatives suggest an old birth, but not strongly enough to expose details. */
  | 'insufficient-evidence'
  | 'no-dates';

export interface LivingResult {
  living: boolean;
  reason: LivingReason;
  /** True when birthYear was estimated from relatives. */
  estimated: boolean;
  birthYear?: number;
}

const isPresent = (value: unknown): boolean =>
  typeof value === 'string' || (typeof value === 'object' && value !== null);

/** Latest year a date could fall in, or undefined when it has no upper bound. */
function latestYear(date: unknown): number | undefined {
  if (!isPresent(date)) return undefined;
  const parsed: ParsedDate = typeof date === 'string' ? parseDate(date) : (date as ParsedDate);
  if (parsed.valid !== true || parsed.qualifier === 'after' || parsed.qualifier === 'from') {
    return undefined;
  }
  const year = Math.floor((parsed.sortKeyEnd ?? parsed.sortKey) / 10000);
  return Number.isFinite(year) ? year : undefined;
}

function estimateBirthYear(input: LivingInput): { year: number; sources: number } | undefined {
  const estimates: number[] = [];
  const add = (dates: unknown, offset: number) => {
    if (!Array.isArray(dates)) return;
    for (const date of dates) {
      const year = latestYear(date);
      if (year !== undefined) estimates.push(year + offset);
    }
  };
  add(input.parentBirths, GENERATION_YEARS);
  add(input.spouseBirths, 0);
  add(input.childBirths, -GENERATION_YEARS);
  return estimates.length ? { year: Math.max(...estimates), sources: estimates.length } : undefined;
}

export function inferLiving(
  input: LivingInput,
  today: Date = new Date(),
  thresholdYears = 100,
): LivingResult {
  const facts: LivingInput = typeof input === 'object' && input !== null ? input : {};
  if (facts.hasDeathFacts === true || isPresent(facts.death) || isPresent(facts.burial)) {
    return { living: false, reason: 'death-facts', estimated: false };
  }
  const own = latestYear(facts.birth);
  const estimate = own === undefined ? estimateBirthYear(facts) : undefined;
  const birthYear = own ?? estimate?.year;
  const currentYear = today instanceof Date ? today.getFullYear() : NaN;
  if (birthYear === undefined || !Number.isFinite(currentYear)) {
    return { living: true, reason: 'no-dates', estimated: false };
  }
  const threshold = Number.isFinite(thresholdYears) && thresholdYears > 0 ? thresholdYears : 100;
  const age = currentYear - birthYear;
  if (estimate) {
    const proven = estimate.sources >= 2 && age >= threshold + ESTIMATE_MARGIN_YEARS;
    return {
      living: !proven,
      reason: proven
        ? 'birth-beyond-threshold'
        : age >= threshold
          ? 'insufficient-evidence'
          : 'birth-within-threshold',
      estimated: true,
      birthYear,
    };
  }
  const living = !(age >= threshold);
  return {
    living,
    reason: living ? 'birth-within-threshold' : 'birth-beyond-threshold',
    estimated: false,
    birthYear,
  };
}
