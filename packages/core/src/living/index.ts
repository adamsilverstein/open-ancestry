/**
 * Living inference, matching Ancestry: a person is living unless they have a
 * death or burial fact or were born `thresholdYears` (100) or more years ago.
 *
 * Without a usable birth date the birth year is estimated from relatives:
 * parent + 25, spouse + 0, child - 25 years. The latest estimate wins so the
 * rule errs toward "living", which hides details rather than exposing them.
 * With no dates at all the person is treated as living, as Ancestry does.
 */
import { yearOf } from '../dates';
import type { DateInput } from '../dates';

export const GENERATION_YEARS = 25;

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
  'death-facts' | 'birth-within-threshold' | 'birth-beyond-threshold' | 'no-dates';

export interface LivingResult {
  living: boolean;
  reason: LivingReason;
  /** True when birthYear was estimated from relatives. */
  estimated: boolean;
  birthYear?: number;
}

function estimateBirthYear(input: LivingInput): number | undefined {
  const estimates: number[] = [];
  const add = (dates: DateInput[] | undefined, offset: number) => {
    for (const date of dates ?? []) {
      const year = yearOf(date);
      if (year !== undefined) estimates.push(year + offset);
    }
  };
  add(input.parentBirths, GENERATION_YEARS);
  add(input.spouseBirths, 0);
  add(input.childBirths, -GENERATION_YEARS);
  return estimates.length ? Math.max(...estimates) : undefined;
}

export function inferLiving(
  input: LivingInput,
  today: Date = new Date(),
  thresholdYears = 100,
): LivingResult {
  if (input.hasDeathFacts || input.death !== undefined || input.burial !== undefined) {
    return { living: false, reason: 'death-facts', estimated: false };
  }
  const own = input.birth === undefined ? undefined : yearOf(input.birth);
  const birthYear = own ?? estimateBirthYear(input);
  if (birthYear === undefined) return { living: true, reason: 'no-dates', estimated: false };
  const living = today.getFullYear() - birthYear < thresholdYears;
  return {
    living,
    reason: living ? 'birth-within-threshold' : 'birth-beyond-threshold',
    estimated: own === undefined,
    birthYear,
  };
}
