import { describe, expect, it } from 'vitest';
import { compareDates, formatDate, parseDate, toGedcom } from './index';

describe('adversarial: dual-dated 29 February', () => {
  // 1752 (new style) is a leap year, so Old Style "29 FEB 1751/52" is a real day.
  it.each(['29 FEB 1751/52', '@#DJULIAN@ 29 FEB 1751/52', '29 FEB 1695/96'])(
    'parses %s',
    (text) => {
      const date = parseDate(text);
      expect(date.valid).toBe(true);
      expect(date.start).toMatchObject({ day: 29, month: 2 });
      expect(toGedcom(date)).not.toMatch(/^\(/);
    },
  );

  it('sorts 29 FEB 1751/52 between 28 FEB and 1 MAR 1751/52', () => {
    const sorted = ['1 MAR 1751/52', '29 FEB 1751/52', '28 FEB 1751/52'].sort(compareDates);
    expect(sorted).toEqual(['28 FEB 1751/52', '29 FEB 1751/52', '1 MAR 1751/52']);
  });
});

describe('adversarial: a trailing phrase drops the qualifier', () => {
  it('keeps BEF in "BEF 1850 (per census)"', () => {
    const date = parseDate('BEF 1850 (per census)');
    expect(date.qualifier).toBe('before');
    expect(compareDates(date, '1850')).toBeLessThan(0);
    expect(toGedcom(date, '7')).toBe('BEF 1850');
  });
  it('keeps AFT in "AFT 1850 (family story)"', () => {
    expect(parseDate('AFT 1850 (family story)').qualifier).toBe('after');
  });
});

describe('a phrase after a qualified date (#272)', () => {
  it.each([
    ['BEF 1850 (per census)', 'before', 'BEF 1850', 'bef. 1850 (per census)'],
    ['AFT 1850 (family story)', 'after', 'AFT 1850', 'aft. 1850 (family story)'],
    ['ABT 1850 (age at census)', 'about', 'ABT 1850', 'abt. 1850 (age at census)'],
    ['CAL 1850 (from age 40)', 'calculated', 'CAL 1850', 'cal. 1850 (from age 40)'],
    ['EST 1850 (guess)', 'estimated', 'EST 1850', 'est. 1850 (guess)'],
    ['abt. 5 Sep 1850 (bible)', 'about', 'ABT 5 SEP 1850', 'abt. 5 Sep 1850 (bible)'],
  ])('%s keeps its qualifier and phrase', (text, qualifier, v7, shown) => {
    const date = parseDate(text);
    expect(date).toMatchObject({
      qualifier,
      valid: true,
      phrase: text.slice(text.indexOf('(') + 1, -1),
    });
    expect(toGedcom(date, '7')).toBe(v7);
    expect(toGedcom(date, '5.5.1')).toBe(v7);
    expect(formatDate(date)).toBe(shown);
    // The display form reads back as the same date.
    expect(parseDate(shown)).toMatchObject({
      qualifier,
      sortKey: date.sortKey,
      phrase: date.phrase,
    });
  });

  it('sorts a qualified date with a phrase like the same date without one', () => {
    expect(parseDate('BEF 1850 (per census)').sortKey).toBe(parseDate('BEF 1850').sortKey);
    expect(parseDate('AFT 1850 (story)').sortKey).toBe(parseDate('AFT 1850').sortKey);
  });

  it('still reads INT with a qualifier, and a plain date with a phrase, as interpreted', () => {
    expect(parseDate('INT ABT 1941 (around the war)').qualifier).toBe('interpreted');
    expect(parseDate('5 SEP 1941 (a note)').qualifier).toBe('interpreted');
  });
});

describe('dual-dated leap days follow Julian (Old Style) rules (#272 review)', () => {
  // 1700 is a Julian leap year but not a Gregorian one; dual dating is Old Style.
  it.each(['29 FEB 1699/1700', '29 FEB 1699/00'])('accepts %s', (text) => {
    expect(parseDate(text)).toMatchObject({ valid: true, start: { day: 29, month: 2 } });
    expect(toGedcom(text)).toBe('29 FEB 1699/00');
    // GEDCOM 7 has no dual years: an Old Style day is a Julian one.
    expect(toGedcom(text, '7')).toBe('JULIAN 29 FEB 1700');
  });
  it.each(['29 FEB 1752/53', '29 FEB 1750/51'])(
    'rejects %s, not a leap year either way',
    (text) => {
      expect(parseDate(text).valid).toBe(false);
    },
  );
});

describe('a note after a range or period (#272 review)', () => {
  it.each([
    [
      'BET 1890 AND 1895 (per census)',
      'between',
      'BET 1890 AND 1895',
      'bet. 1890 and 1895 (per census)',
    ],
    ['FROM 1890 TO 1895 (lease)', 'from_to', 'FROM 1890 TO 1895', 'from 1890 to 1895 (lease)'],
    ['FROM 1890 (lease)', 'from', 'FROM 1890', 'from 1890 (lease)'],
    ['TO 1895 (lease)', 'to', 'TO 1895', 'to 1895 (lease)'],
    ['1850s (family story)', 'between', 'BET 1850 AND 1859', 'bet. 1850 and 1859 (family story)'],
    ['@#DJULIAN@ ABT 1700 (old style)', 'about', 'ABT JULIAN 1700', 'abt. Julian 1700 (old style)'],
  ])('%s keeps its form and phrase', (text, qualifier, v7, shown) => {
    const date = parseDate(text);
    expect(date).toMatchObject({
      qualifier,
      valid: true,
      phrase: text.slice(text.indexOf('(') + 1, -1),
    });
    expect(toGedcom(date, '7')).toBe(v7);
    expect(formatDate(date)).toBe(shown);
    expect(parseDate(shown)).toMatchObject({
      qualifier,
      sortKey: date.sortKey,
      phrase: date.phrase,
    });
  });
});
