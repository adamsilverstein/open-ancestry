import { asParsed } from './format';
import type { DateInput, DateQualifier } from './types';

// Tie-break for equal sort keys, so the order is total and stable.
const RANK: Record<DateQualifier, number> = {
  before: 0,
  to: 1,
  exact: 2,
  interpreted: 3,
  calculated: 4,
  estimated: 5,
  about: 6,
  from: 7,
  between: 8,
  from_to: 9,
  after: 10,
  text: 11,
};

const cmp = (a: number | string, b: number | string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Chronological comparator for Array.prototype.sort; undated text sorts last. */
export function compareDates(a: DateInput, b: DateInput): number {
  const pa = asParsed(a);
  const pb = asParsed(b);
  return (
    cmp(pa.sortKey, pb.sortKey) ||
    cmp(pa.sortKeyEnd ?? pa.sortKey, pb.sortKeyEnd ?? pb.sortKey) ||
    cmp(RANK[pa.qualifier], RANK[pb.qualifier]) ||
    cmp(pa.text, pb.text)
  );
}

/** Gregorian year a date sorts in (new-style for dual years), or undefined for text. */
export function yearOf(date: DateInput): number | undefined {
  const parsed = asParsed(date);
  return parsed.valid ? Math.floor(parsed.sortKey / 10000) : undefined;
}
