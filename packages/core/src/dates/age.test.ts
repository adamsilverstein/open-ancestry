import { describe, expect, it } from 'vitest';
import { ageAt, parseDate } from './index';

describe('ageAt', () => {
  it.each([
    ['5 SEP 1941', '5 SEP 1966', 25, false],
    ['5 SEP 1941', '4 SEP 1966', 24, false],
    ['5 SEP 1941', '6 SEP 1966', 25, false],
    ['5 SEP 1941', '5 SEP 1941', 0, false],
    ['5 SEP 1941', 'OCT 1966', 25, false],
    ['5 SEP 1941', 'AUG 1966', 24, false],
    ['5 SEP 1941', 'SEP 1966', 25, true],
    ['SEP 1941', 'OCT 1966', 25, false],
    ['SEP 1941', 'AUG 1966', 24, false],
    ['SEP 1941', 'SEP 1966', 25, true],
    ['SEP 1941', '5 SEP 1966', 25, true],
    ['1941', '5 SEP 1966', 25, true],
    ['5 SEP 1941', '1966', 25, true],
    ['ABT 1941', '1966', 25, true],
    ['ABT 5 SEP 1941', '5 SEP 1966', 25, true],
    ['5 SEP 1941', 'EST 5 SEP 1966', 25, true],
    ['BEF 1900', '1950', 50, true],
    ['AFT 1900', '1950', 50, true],
    ['BET 1890 AND 1900', '1950', 55, true],
    ['FROM 1890 TO 1900', '1950', 55, true],
    ['11 FEB 1731/32', '11 FEB 1752', 20, false],
    ['29 FEB 2000', '28 FEB 2001', 0, false],
    ['29 FEB 2000', '1 MAR 2001', 1, false],
    ['10 B.C.', '10', 19, true],
    ['JULIAN 5 SEP 1700', '16 SEP 1725', 25, false],
    ['JULIAN 5 SEP 1700', '15 SEP 1725', 24, false],
    ['05/28/1960', '2010-2019', 54, true],
  ] as const)('born %s, event %s -> %i (approximate %s)', (birth, event, years, approximate) => {
    expect(ageAt(birth, event)).toEqual({
      years,
      approximate,
      text: approximate ? `about ${years}` : String(years),
    });
  });

  it('accepts parsed dates', () => {
    expect(ageAt(parseDate('1900'), parseDate('ABT 1925'))?.text).toBe('about 25');
  });

  it.each([
    ['unknown', '1950'],
    ['1950', 'unknown'],
    ['', ''],
    ['1950', '1949'],
    ['5 SEP 1950', '4 SEP 1950'],
  ])('is undefined for %j / %j', (birth, event) => {
    expect(ageAt(birth, event)).toBeUndefined();
  });
});
