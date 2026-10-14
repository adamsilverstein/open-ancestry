import { parseDate } from '@open-ancestry/core';

/** Earliest and latest possible day of a date, as YYYYMMDD numbers (±Infinity when open). */
export type DateRange = [number, number];

const key = (year: number, month: number, day: number) => year * 10000 + month * 100 + day;

/** Years of slack for `abt.`, `est.` and `cal.` dates. */
const APPROXIMATE_YEARS = 1;

/**
 * The span of days a genealogical date could mean: `1880` is all of 1880,
 * `MAR 1880` all of March, `ABT 1880` 1879-1881, `BEF 1880` anything up to it,
 * `BET 1880 AND 1885` the whole range. Unparseable text returns null.
 */
export function dateRange(text: string | null | undefined): DateRange | null {
  if (!text) return null;
  const parsed = parseDate(text);
  const { start, end, qualifier } = parsed;
  if (!parsed.valid || !start) return null;
  const first = key(start.year, start.month ?? 1, start.day ?? 1);
  const lastOf = (p: typeof start) => key(p.year, p.month ?? 12, p.day ?? 31);
  let range: DateRange = [first, lastOf(end ?? start)];
  if (qualifier === 'about' || qualifier === 'estimated' || qualifier === 'calculated') {
    range = [range[0] - APPROXIMATE_YEARS * 10000, range[1] + APPROXIMATE_YEARS * 10000];
  } else if (qualifier === 'before' || qualifier === 'to') {
    range = [-Infinity, range[1]];
  } else if (qualifier === 'after' || qualifier === 'from') {
    range = [range[0], Infinity];
  }
  return range;
}

/** True when the two spans share at least one possible day. */
export const overlaps = (a: DateRange, b: DateRange) => a[0] <= b[1] && b[0] <= a[1];
