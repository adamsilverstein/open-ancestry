import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareDates, parseDate, UNDATED_SORT_KEY, yearOf } from './index';
import { arbDateText, arbPoint, pointText } from './test-arbitraries';

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
    ['11 FEB 1731/32', 17320211],
    ['44 B.C.', -44 * 10000 + 701],
    ['15 MAR 44 B.C.', -44 * 10000 + 315],
    ['JULIAN 5 SEP 1700', 17000916],
    ['JULIAN 25 DEC 1700', 17010105],
    ['JULIAN SEP 1700', 17000915],
  ])('%s -> %i', (input, key) => {
    expect(parseDate(input).sortKey).toBe(key);
  });

  it('sets both bounds for ranges', () => {
    expect(parseDate('BET 1890 AND 1895')).toMatchObject({ sortKey: 18900101, sortKeyEnd: 18951231 });
    expect(parseDate('FROM SEP 1890 TO 5 OCT 1895')).toMatchObject({ sortKey: 18900901, sortKeyEnd: 18951005 });
    expect(parseDate('1941').sortKeyEnd).toBeUndefined();
  });

  it('approximates Hebrew and French Republican dates onto the Gregorian timeline', () => {
    const hebrew = parseDate('@#DHEBREW@ 1 TSH 5700').sortKey;
    expect(hebrew).toBeGreaterThan(19390800);
    expect(hebrew).toBeLessThan(19391100);
    const french = parseDate('@#DFRENCH R@ 1 VEND 1').sortKey;
    expect(french).toBeGreaterThan(17920800);
    expect(french).toBeLessThan(17921100);
    expect(parseDate('@#DFRENCH R@ 1 PLUV 1').sortKey).toBeGreaterThan(17930100);
    expect(parseDate('@#DHEBREW@ 5700').sortKey).toBeGreaterThan(19390000);
  });

  it('uses the undated key for text', () => {
    expect(parseDate('unknown').sortKey).toBe(UNDATED_SORT_KEY);
  });
});

describe('sortKey properties', () => {
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
      fc.property(fc.integer({ min: 1, max: 2100 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }), (y, m, day) => {
        const full = parseDate(pointText({ year: y, month: m, day })).sortKey;
        for (const partial of [pointText({ year: y, month: m }), String(y)]) {
          expect(parseDate(`BEF ${partial}`).sortKey).toBeLessThan(full);
          expect(parseDate(`AFT ${partial}`).sortKey).toBeGreaterThan(full);
        }
      }),
    );
  });

  it('matches chronological order for full Gregorian dates', () => {
    const arbDay = fc.date({ min: new Date('0100-01-01T00:00:00Z'), max: new Date('2100-12-31T00:00:00Z'), noInvalidDate: true });
    fc.assert(
      fc.property(arbDay, arbDay, (a, b) => {
        const text = (dt: Date) => pointText({ year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() });
        const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
        const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
        expect(Math.sign(compareDates(text(a), text(b)))).toBe(Math.sign(da - db));
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
    const sorted = ['unknown', 'AFT 2000', '44 B.C.', 'BEF 1900', '1900', 'ABT 1900'].sort(compareDates);
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
