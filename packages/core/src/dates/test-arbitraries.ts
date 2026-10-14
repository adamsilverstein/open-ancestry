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
);
