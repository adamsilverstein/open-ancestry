import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareDates, parseDate, UNDATED_SORT_KEY, yearOf } from './index';
import {
  arbCalendarText,
  arbDateText,
  arbMixedRange,
  arbPoint,
  pointText,
} from './test-arbitraries';

// Property tests run hundreds of cases; under coverage on a shared CI runner that can
// pass Vitest's 5s default, so they get room. A hang still fails.
const PROPERTY_TIMEOUT = 30_000;

describe('sortKey', () => {
  it.each([
    ['5 SEP 1941', 19410905],
    ['SEP 1941', 19410915],
    ['1941', 19410701],
    ['ABT 1941', 19410701],
    ['CAL 1941', 19410701],
    ['BEF 1941', 19410100],
    ['AFT 1941', 19411232],
    ['BEF SEP 1941', 19410900],
    ['AFT SEP 1941', 19410932],
    ['BEF 5 SEP 1941', 19410904],
    ['AFT 5 SEP 1941', 19410906],
    ['FROM 1941', 19410701],
    ['TO 1941', 19410701],
    ['1750/51', 17510701],
    // A dual date is Old Style: Julian 11 Feb 1732 is Gregorian 22 Feb 1732 (#298).
    ['11 FEB 1731/32', 17320222],
    ['29 FEB 1751/52', 17520311],
    ['44 B.C.', -44 * 10000 + 701],
    ['15 MAR 44 B.C.', -44 * 10000 + 315],
    ['JULIAN 5 SEP 1700', 17000916],
    ['JULIAN 25 DEC 1700', 17010105],
    ['JULIAN SEP 1700', 17000915],
  ])('%s -> %i', (input, key) => {
    expect(parseDate(input).sortKey).toBe(key);
  });

  it('sets both bounds for ranges', () => {
    expect(parseDate('BET 1890 AND 1895')).toMatchObject({
      sortKey: 18900101,
      sortKeyEnd: 18951231,
    });
    expect(parseDate('FROM SEP 1890 TO 5 OCT 1895')).toMatchObject({
      sortKey: 18900901,
      sortKeyEnd: 18951005,
    });
    expect(parseDate('1941').sortKeyEnd).toBeUndefined();
  });

  it.each([
    // Hebrew, checked against published calendars.
    ['@#DHEBREW@ 1 TSH 5700', 19390914],
    ['@#DHEBREW@ 1 TSH 5780', 20190930],
    ['@#DHEBREW@ 25 KSL 5784', 20231208],
    ['@#DHEBREW@ 14 ADR 5783', 20230307],
    ['@#DHEBREW@ 14 ADS 5783', 20230307],
    ['@#DHEBREW@ 14 ADR 5784', 20240223],
    ['@#DHEBREW@ 14 ADS 5784', 20240324],
    ['@#DHEBREW@ 15 NSN 5785', 20250413],
    ['@#DHEBREW@ 9 AAV 5784', 20240813],
    ['@#DHEBREW@ 29 ELL 5784', 20241002],
    ['@#DHEBREW@ 1 TSH 5785', 20241003],
    // French Republican, including the sextile years III, VII and XI.
    ['@#DFRENCH R@ 1 VEND 1', 17920922],
    ['@#DFRENCH R@ 1 VEND 2', 17930922],
    ['@#DFRENCH R@ 9 THER 2', 17940727],
    ['@#DFRENCH R@ 6 COMP 3', 17950922],
    ['@#DFRENCH R@ 1 VEND 4', 17950923],
    ['@#DFRENCH R@ 18 BRUM 8', 17991109],
    ['@#DFRENCH R@ 11 FRIM 13', 18041202],
    ['@#DFRENCH R@ 1 VEND 14', 18050923],
  ])('converts %s exactly -> %i', (input, key) => {
    expect(parseDate(input).sortKey).toBe(key);
  });

  it('bounds Hebrew and French years and months by their real lengths', () => {
    expect(parseDate('BET @#DHEBREW@ 5784 AND @#DHEBREW@ 5784')).toMatchObject({
      sortKey: 20230916,
      sortKeyEnd: 20241002,
    });
    expect(parseDate('AFT @#DHEBREW@ ELL 5784').sortKey).toBe(20241003);
    expect(parseDate('BEF @#DHEBREW@ TSH 5785').sortKey).toBe(20241002);
    expect(parseDate('BET @#DFRENCH R@ COMP 2 AND @#DFRENCH R@ COMP 2')).toMatchObject({
      sortKey: 17940917,
      sortKeyEnd: 17940921,
    });
    expect(parseDate('@#DHEBREW@ 5700').sortKey).toBeGreaterThan(19390914);
    expect(parseDate('@#DHEBREW@ 5700').sortKey).toBeLessThan(19400902);
  });

  it('uses the undated key for text', () => {
    expect(parseDate('unknown').sortKey).toBe(UNDATED_SORT_KEY);
  });
});

describe('sortKey properties', { timeout: PROPERTY_TIMEOUT }, () => {
  it('orders BEF X < X == ABT X < AFT X for any point', () => {
    fc.assert(
      fc.property(arbPoint, (point) => {
        const text = pointText(point);
        const exact = parseDate(text).sortKey;
        expect(parseDate(`BEF ${text}`).sortKey).toBeLessThan(exact);
        expect(parseDate(`AFT ${text}`).sortKey).toBeGreaterThan(exact);
        expect(parseDate(`ABT ${text}`).sortKey).toBe(exact);
      }),
    );
  });

  it('places every day of a partial date strictly between its BEF and AFT keys', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (y, m, day) => {
          const full = parseDate(pointText({ year: y, month: m, day })).sortKey;
          for (const partial of [pointText({ year: y, month: m }), String(y)]) {
            expect(parseDate(`BEF ${partial}`).sortKey).toBeLessThan(full);
            expect(parseDate(`AFT ${partial}`).sortKey).toBeGreaterThan(full);
          }
        },
      ),
    );
  });

  it('matches chronological order for full Gregorian dates', () => {
    const arbDay = fc.date({
      min: new Date('0100-01-01T00:00:00Z'),
      max: new Date('2100-12-31T00:00:00Z'),
      noInvalidDate: true,
    });
    fc.assert(
      fc.property(arbDay, arbDay, (a, b) => {
        const text = (dt: Date) =>
          pointText({
            year: dt.getUTCFullYear(),
            month: dt.getUTCMonth() + 1,
            day: dt.getUTCDate(),
          });
        const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
        const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
        expect(Math.sign(compareDates(text(a), text(b)))).toBe(Math.sign(da - db));
      }),
    );
  });

  it('orders BEF X < X < AFT X for Hebrew and French dates, inside their month and year', () => {
    fc.assert(
      fc.property(arbCalendarText, (text) => {
        const exact = parseDate(text);
        expect(exact.valid).toBe(true);
        expect(parseDate(`BEF ${text}`).sortKey).toBeLessThan(exact.sortKey);
        expect(parseDate(`AFT ${text}`).sortKey).toBeGreaterThan(exact.sortKey);
        // A day sorts within its month's and year's range.
        const day = /^(@#D[A-Z ]+@) \d+ (\S+) (\d+)$/.exec(text);
        if (day) {
          const [, escape, month, year] = day;
          for (const outer of [`${escape} ${month} ${year}`, `${escape} ${year}`]) {
            const range = parseDate(`BET ${outer} AND ${outer}`);
            expect(exact.sortKey).toBeGreaterThanOrEqual(range.sortKey);
            expect(exact.sortKey).toBeLessThanOrEqual(range.sortKeyEnd!);
          }
        }
      }),
    );
  });

  it('keeps mixed-calendar ranges valid and ordered', () => {
    fc.assert(
      fc.property(arbMixedRange, (text) => {
        const parsed = parseDate(text);
        expect(parsed.valid).toBe(true);
        expect(parsed.endCalendar).toBeDefined();
        expect(parsed.sortKey).toBeLessThanOrEqual(parsed.sortKeyEnd!);
      }),
    );
  });

  const arbAny = fc.oneof(arbDateText, fc.string());

  it('compareDates is antisymmetric and reflexive', () => {
    fc.assert(
      fc.property(arbAny, arbAny, (a, b) => {
        expect(compareDates(a, a)).toBe(0);
        expect(Math.sign(compareDates(a, b))).toBe(-Math.sign(compareDates(b, a)) || 0);
      }),
    );
  });

  it('compareDates is transitive', () => {
    fc.assert(
      fc.property(arbAny, arbAny, arbAny, (a, b, c) => {
        const sorted = [a, b, c].sort(compareDates);
        expect(compareDates(sorted[0]!, sorted[1]!)).toBeLessThanOrEqual(0);
        expect(compareDates(sorted[1]!, sorted[2]!)).toBeLessThanOrEqual(0);
        expect(compareDates(sorted[0]!, sorted[2]!)).toBeLessThanOrEqual(0);
      }),
    );
  });
});

describe('compareDates', () => {
  it('sorts undated text after every real date', () => {
    const sorted = ['unknown', 'AFT 2000', '44 B.C.', 'BEF 1900', '1900', 'ABT 1900'].sort(
      compareDates,
    );
    expect(sorted).toEqual(['44 B.C.', 'BEF 1900', '1900', 'ABT 1900', 'AFT 2000', 'unknown']);
  });

  it('accepts parsed dates', () => {
    expect(compareDates(parseDate('1900'), parseDate('1901'))).toBeLessThan(0);
  });

  it('breaks key ties between ranges by their end', () => {
    expect(compareDates('BET 1890 AND 1891', 'BET 1890 AND 1895')).toBeLessThan(0);
  });
});

describe('yearOf', () => {
  it.each([
    ['5 SEP 1941', 1941],
    ['ABT 1890', 1890],
    ['BEF 1900', 1900],
    ['AFT 1900', 1900],
    ['BET 1890 AND 1895', 1890],
    ['1750/51', 1751],
    ['44 B.C.', -44],
    ['JULIAN 25 DEC 1700', 1701],
  ])('%s -> %i', (input, year) => {
    expect(yearOf(input)).toBe(year);
  });

  it('is undefined for text', () => {
    expect(yearOf('unknown')).toBeUndefined();
    expect(yearOf(parseDate(''))).toBeUndefined();
  });
});

describe('dual dates sort as Julian (#298)', () => {
  it('gives a dual date the same key as the Julian date it is', () => {
    expect(parseDate('29 FEB 1751/52').sortKey).toBe(parseDate('@#DJULIAN@ 29 FEB 1752').sortKey);
    expect(parseDate('ABT 11 FEB 1731/32').sortKey).toBe(
      parseDate('ABT @#DJULIAN@ 11 FEB 1732').sortKey,
    );
  });

  it('agrees with the Julian date for any day', () => {
    const MON = [
      'JAN',
      'FEB',
      'MAR',
      'APR',
      'MAY',
      'JUN',
      'JUL',
      'AUG',
      'SEP',
      'OCT',
      'NOV',
      'DEC',
    ];
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 1998 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (year, month, day) => {
          const dual = `${day} ${MON[month - 1]} ${year}/${String((year + 1) % 100).padStart(2, '0')}`;
          const julian = `@#DJULIAN@ ${day} ${MON[month - 1]} ${year + 1}`;
          expect(parseDate(dual).sortKey).toBe(parseDate(julian).sortKey);
        },
      ),
    );
  });
});
