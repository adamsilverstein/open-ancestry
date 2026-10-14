/** fast-check generators shared by the date property tests. Not part of the public API. */
import fc from 'fast-check';
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

interface Span {
  text: string;
  first: number;
  last: number;
}

/** Last year of `<first>s`: a century when it ends in 00 before 2000, else a decade. */
const spanEnd = (first: number) => first + (first % 100 === 0 && first < 2000 ? 99 : 9);

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
    // The end follows the parser's rule: `1350s-1400s` runs to the end of the 1400s century.
    last: spanEnd((d + gap) * 10),
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
  fc.tuple(arbDecade, arbDecade).map(([a, b]) => {
    const [lo, hi] = a.first <= b.first ? [a, b] : [b, a];
    const last = Math.max(lo.last, hi.last);
    // A century contains its decades, so the period ends at whichever span ends later.
    return lo.last > hi.last
      ? { text: `FROM ${lo.text} TO ${lo.text}`, means: `FROM ${lo.first} TO ${lo.last}` }
      : { text: `FROM ${lo.text} TO ${hi.text}`, means: `FROM ${lo.first} TO ${last}` };
  }),
  fc.tuple(arbDecade, arbDecade).map(([a, b]) => {
    const [lo, hi] = a.first <= b.first ? [a, b] : [b, a];
    return lo.last > hi.last
      ? { text: `BET ${lo.text} AND ${lo.text}`, means: `BET ${lo.first} AND ${lo.last}` }
      : { text: `BET ${lo.text} AND ${hi.text}`, means: `BET ${lo.first} AND ${hi.last}` };
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
  arbSpanDate.map((d) => d.text),
);
