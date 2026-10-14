/**
 * Sort keys: an integer `YYYYMMDD` (year * 10000 + month * 100 + day) on the
 * Gregorian timeline, so dates sort with a plain integer index.
 *
 * - Missing parts take the midpoint: `1941` is 1941-07-01, `SEP 1941` is 1941-09-15.
 * - `BEF X` is one below the first day X could be (`BEF 1941` = 19410100) and
 *   `AFT X` one above the last (`AFT 1941` = 19411232), so for the same date
 *   before < exact < after. The out-of-range days are never real dates.
 * - `ABT`, `CAL`, `EST`, `INT`, `FROM` and `TO` sort at the midpoint like exact dates.
 * - `BET` and `FROM .. TO` sort by their earliest day; `sortKeyEnd` is the latest.
 * - Dual years sort by the new-style year (`1750/51` as 1751).
 * - Julian full dates are converted exactly; Hebrew and French Republican are approximate.
 * - B.C. years are negative; the encoding stays monotonic.
 * - Unparseable text gets UNDATED_SORT_KEY so it sorts after every date.
 */
import { daysInMonth, monthsInYear, toGregorian } from './calendar';
import type { Calendar, DatePoint } from './types';

export const UNDATED_SORT_KEY = Number.MAX_SAFE_INTEGER;

const encode = (year: number, month: number, day: number): number => year * 10000 + month * 100 + day;

type Bound = 'low' | 'mid' | 'high';

export function pointKey(point: DatePoint, calendar: Calendar, bound: Bound): number {
  const year = point.dualYear ?? point.year;
  const { month, day } = point;
  if (calendar === 'hebrew' || calendar === 'french_r') {
    const last = monthsInYear(calendar);
    const m = month ?? (bound === 'low' ? 1 : bound === 'high' ? last : 7);
    const d = day ?? (bound === 'low' ? 1 : bound === 'high' ? daysInMonth(calendar, year, m) : month === undefined ? 1 : 15);
    const g = toGregorian(calendar, year, m, d);
    return encode(g.year, g.month, g.day);
  }
  if (month === undefined) return bound === 'low' ? encode(year, 1, 1) : bound === 'high' ? encode(year, 12, 31) : encode(year, 7, 1);
  if (day === undefined) return encode(year, month, bound === 'low' ? 1 : bound === 'high' ? 31 : 15);
  const g = toGregorian(calendar, year, month, day);
  return encode(g.year, g.month, g.day);
}
