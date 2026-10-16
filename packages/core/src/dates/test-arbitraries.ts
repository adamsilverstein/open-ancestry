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

interface Span {
  text: string;
  first: number;
  last: number;
}

/** Last year of `<first>s`: a century when it ends in 00 before 2000, else a decade. */
const spanEnd = (first: number) => first + (first % 100 === 0 && first < 2000 ? 99 : 9);

/** Last year of `<right>s` after `<left>s`: a century only when the left side is one. */
const rightEnd = (left: number, right: number) =>
  right + (left % 100 === 0 && left < 2000 && right % 100 === 0 && right < 2000 ? 99 : 9);

/** A decade (`1850s`, `1850's`, `2000s`) or a century before 2000 (`1700s`). */
export const arbDecade: fc.Arbitrary<Span> = fc
  .tuple(fc.integer({ min: 1, max: 209 }), fc.constantFrom('s', "'s", 'S'))
  .map(([d, suffix]) => {
    const first = d * 10;
    return { text: `${first}${suffix}`, first, last: spanEnd(first) };
  });

/** A hyphenated span: `1850-1860`, `1850-60` (never a month) or `1850s-1860s`. */
export const arbHyphenSpan: fc.Arbitrary<Span> = fc.oneof(
  fc
    .tuple(fc.integer({ min: 1000, max: 2099 }), fc.integer({ min: 0, max: 99 }))
    .map(([first, gap]) => ({ text: `${first}-${first + gap}`, first, last: first + gap })),
  fc
    .tuple(fc.integer({ min: 1000, max: 2086 }), fc.integer({ min: 13, max: 99 }))
    .filter(([first, two]) => first - (first % 100) + two >= first)
    .map(([first, two]) => ({
      text: `${first}-${two}`,
      first,
      last: first - (first % 100) + two,
    })),
  fc.tuple(fc.integer({ min: 101, max: 203 }), fc.integer({ min: 0, max: 5 })).map(([d, gap]) => ({
    text: `${d * 10}s-${(d + gap) * 10}s`,
    first: d * 10,
    // The right side is read at the left side's granularity: `1350s-1400s` ends in 1409.
    last: rightEnd(d * 10, (d + gap) * 10),
  })),
);

/**
 * Span dates as Ancestry writes them (#33, #52, #66), each with the GEDCOM
 * date it means: bare and qualified spans, BEF/AFT a span, and FROM/TO
 * periods bounded by spans.
 */
export const arbSpanDate: fc.Arbitrary<{ text: string; means: string }> = fc.oneof(
  fc.oneof(arbDecade, arbHyphenSpan).chain((s) =>
    fc.oneof(
      fc.constant({ text: s.text, means: `BET ${s.first} AND ${s.last}` }),
      fc
        .constantFrom('Abt.', 'c.', 'circa', 'Est.', 'Cal', 'Bet.')
        .map((q) => ({ text: `${q} ${s.text}`, means: `BET ${s.first} AND ${s.last}` })),
      fc.constant({ text: `Bef. ${s.text}`, means: `BEF ${s.last}` }),
      fc.constant({ text: `Aft. ${s.text}`, means: `AFT ${s.first}` }),
      fc.constant({ text: `TO ${s.text}`, means: `TO ${s.last}` }),
    ),
  ),
  arbDecade.map((s) => ({ text: `FROM ${s.text}`, means: `FROM ${s.first}` })),
  arbHyphenSpan.map((s) => ({ text: `FROM ${s.text}`, means: `FROM ${s.first} TO ${s.last}` })),
  fc
    .tuple(arbDecade, arbDecade, fc.constantFrom(['FROM', 'TO'], ['BET', 'AND']))
    .map(([a, b, [k1, k2]]) => {
      const [lo, hi] = a.first <= b.first ? [a, b] : [b, a];
      // The right side is read at the left side's granularity.
      const end = rightEnd(lo.first, hi.first);
      return { text: `${k1} ${lo.text} ${k2} ${hi.text}`, means: `${k1} ${lo.first} ${k2} ${end}` };
    }),
);

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
  // A note after a qualified date (#272): the qualifier is kept.
  fc
    .tuple(
      fc.constantFrom('ABT', 'CAL', 'EST', 'BEF', 'AFT'),
      arbPoint,
      fc.constantFrom('per census', 'family story', 'from age 40'),
    )
    .map(([q, p, note]) => `${q} ${pointText(p)} (${note})`),
  // Dual-dated leap days, which exist only in the new-style year (#272).
  fc
    .integer({ min: 1000, max: 1998 })
    .filter((y) => ((y + 1) % 4 === 0 && (y + 1) % 100 !== 0) || (y + 1) % 400 === 0)
    .map((y) => `29 FEB ${y}/${String((y + 1) % 100).padStart(2, '0')}`),

  arbSpanDate.map((d) => d.text),
);
