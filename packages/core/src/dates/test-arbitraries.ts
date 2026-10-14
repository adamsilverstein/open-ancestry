/** fast-check generators shared by the date property tests. Not part of the public API. */
import fc from 'fast-check';
import { exactMonthDays, FRENCH_MONTHS, HEBREW_MONTHS, isHebrewLeap } from './calendar';
import type { DatePoint } from './types';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export const arbPoint: fc.Arbitrary<DatePoint> = fc
  .record({
    year: fc.oneof(fc.integer({ min: 1, max: 2100 }), fc.integer({ min: -3000, max: -1 })),
    month: fc.option(fc.integer({ min: 1, max: 12 }), { nil: undefined }),
    day: fc.option(fc.integer({ min: 1, max: 28 }), { nil: undefined }),
  })
  .map(({ year, month, day }) => {
    const point: DatePoint = { year };
    if (month !== undefined) {
      point.month = month;
      if (day !== undefined) point.day = day;
    }
    return point;
  });

/** GEDCOM 5.5.1 text for a point, e.g. `5 SEP 1941` or `44 B.C.`. */
export function pointText(point: DatePoint): string {
  const parts: string[] = [];
  if (point.day !== undefined) parts.push(String(point.day));
  if (point.month !== undefined) parts.push(MONTHS[point.month - 1]!);
  parts.push(point.year < 0 ? `${-point.year} B.C.` : String(point.year));
  return parts.join(' ');
}

const order = (a: DatePoint, b: DatePoint): [DatePoint, DatePoint] =>
  a.year <= b.year ? [a, b] : [b, a];

/** A valid Hebrew or French Republican day, month or year as GEDCOM 5.5.1 text. */
export const arbCalendarText: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('hebrew' as const, 'french_r' as const),
    fc.integer({ min: 1, max: 13 }),
    fc.integer({ min: 1, max: 30 }),
    fc.constantFrom('day', 'month', 'year'),
    fc.integer({ min: 1, max: 1000 }),
  )
  .map(([calendar, month, d, precision, offset]) => {
    const hebrew = calendar === 'hebrew';
    // Hebrew 5000-5999 (1239-2239); French I-XIV, when the calendar was in use.
    const year = hebrew ? 5000 + (offset % 1000) : 1 + (offset % 14);
    // ADS (Adar II) only in leap years.
    const m = hebrew && month === 7 && !isHebrewLeap(year) ? 6 : month;
    const code = (hebrew ? HEBREW_MONTHS : FRENCH_MONTHS)[m - 1]!;
    const day = 1 + ((d - 1) % exactMonthDays(calendar, year, m));
    const escape = hebrew ? '@#DHEBREW@' : '@#DFRENCH R@';
    if (precision === 'year') return `${escape} ${year}`;
    return precision === 'month' ? `${escape} ${code} ${year}` : `${escape} ${day} ${code} ${year}`;
  });

/** Ranges whose ends are in different calendars, always in order. */
export const arbMixedRange: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('BET', 'FROM'),
    fc.integer({ min: 1000, max: 2000 }),
    fc.integer({ min: 0, max: 50 }),
    fc.constantFrom('julian-first', 'julian-last', 'hebrew-first', 'french-first'),
  )
  .map(([kind, year, gap, shape]) => {
    const [first, last] = (() => {
      switch (shape) {
        case 'julian-first':
          return [`@#DJULIAN@ ${year}`, String(year + gap)];
        case 'julian-last':
          // A Julian year starts later than the Gregorian one, so keep a gap.
          return [String(year), `@#DJULIAN@ ${year + gap + 1}`];
        case 'hebrew-first':
          return [`@#DHEBREW@ ${year + 3760}`, String(year + gap + 1)];
        default:
          return [`@#DFRENCH R@ ${1 + (gap % 14)}`, String(1806 + gap)];
      }
    })();
    return kind === 'BET' ? `BET ${first} AND ${last}` : `FROM ${first} TO ${last}`;
  });

/** Valid GEDCOM date strings across every qualifier and range form. */
export const arbDateText: fc.Arbitrary<string> = fc.oneof(
  arbPoint.map(pointText),
  fc
    .tuple(
      fc.constantFrom('ABT', 'CAL', 'EST', 'BEF', 'AFT', 'FROM', 'TO', '@#DJULIAN@', 'INT'),
      arbPoint,
    )
    .map(([q, p]) => `${q} ${pointText(p)}`),
  fc.tuple(arbPoint, arbPoint).map(([a, b]) => {
    const [lo, hi] = order({ year: a.year }, { year: b.year });
    return `BET ${pointText(lo)} AND ${pointText(hi)}`;
  }),
  fc.tuple(arbPoint, arbPoint).map(([a, b]) => {
    const [lo, hi] = order({ year: a.year }, { year: b.year });
    return `FROM ${pointText(lo)} TO ${pointText(hi)}`;
  }),
  fc.integer({ min: 1000, max: 1998 }).map((y) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`),
  arbCalendarText,
  fc
    .tuple(fc.constantFrom('ABT', 'BEF', 'AFT', 'EST'), arbCalendarText)
    .map(([q, d]) => `${q} ${d}`),
  arbMixedRange,
);
