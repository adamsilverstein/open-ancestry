import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatDate, parseDate, toGedcom } from './index';
import type { ParsedDate } from './types';
import { arbDateText } from './test-arbitraries';

describe('formatDate', () => {
  it.each([
    ['5 SEP 1941', '5 Sep 1941'],
    ['05 SEP 1941', '5 Sep 1941'],
    ['SEP 1941', 'Sep 1941'],
    ['1941', '1941'],
    ['05/28/1960', '28 May 1960'],
    ['ABT 1890', 'abt. 1890'],
    ['c. 1890', 'abt. 1890'],
    ['CAL 1890', 'cal. 1890'],
    ['EST 1890', 'est. 1890'],
    ['BEF 1900', 'bef. 1900'],
    ['AFT 1 JAN 1900', 'aft. 1 Jan 1900'],
    ['BET 1890 AND 1895', 'bet. 1890 and 1895'],
    ['2010-2019', 'bet. 2010 and 2019'],
    ['FROM 1890 TO 1895', 'from 1890 to 1895'],
    ['FROM 1890', 'from 1890'],
    ['TO 1895', 'to 1895'],
    ['INT 5 SEP 1941 (fifth of September)', 'int. 5 Sep 1941 (fifth of September)'],
    ['INT 1941', 'int. 1941'],
    ['1750/51', '1750/51'],
    ['1699/00', '1699/00'],
    ['44 B.C.', '44 B.C.'],
    ['@#DJULIAN@ 5 SEP 1700', 'Julian 5 Sep 1700'],
    ['@#DHEBREW@ 1 TSH 5700', 'Hebrew 1 Tsh 5700'],
    ['@#DFRENCH R@ 1 VEND 1', 'French Republican 1 Vend 1'],
    ['@#DUNKNOWN@ 1900', '1900'],
    ['  some free text  ', 'some free text'],
    ['', ''],
  ])('%j -> %j', (input, output) => {
    expect(formatDate(parseDate(input))).toBe(output);
    expect(formatDate(input, 'long')).toBe(output);
  });

  it.each([
    ['5 SEP 1941', '1941'],
    ['ABT SEP 1890', 'abt. 1890'],
    ['BEF 3 JAN 1900', 'bef. 1900'],
    ['BET 5 MAY 1890 AND JUN 1895', 'bet. 1890 and 1895'],
    ['1750/51', '1750/51'],
    ['44 B.C.', '44 B.C.'],
    ['unknown', 'unknown'],
  ])('year style %j -> %j', (input, output) => {
    expect(formatDate(input, 'year')).toBe(output);
  });
});

describe('toGedcom', () => {
  it.each([
    ['5 Sep 1941', '5 SEP 1941', '5 SEP 1941'],
    ['abt 1890', 'ABT 1890', 'ABT 1890'],
    ['c. 1890', 'ABT 1890', 'ABT 1890'],
    ['calc 1890', 'CAL 1890', 'CAL 1890'],
    ['estimated 1890', 'EST 1890', 'EST 1890'],
    ['before 1900', 'BEF 1900', 'BEF 1900'],
    ['after Sep 1900', 'AFT SEP 1900', 'AFT SEP 1900'],
    ['Bet. 1890 and 1895', 'BET 1890 AND 1895', 'BET 1890 AND 1895'],
    ['2010-2019', 'BET 2010 AND 2019', 'BET 2010 AND 2019'],
    ['1890s', 'BET 1890 AND 1899', 'BET 1890 AND 1899'],
    ['from 1890 to 1895', 'FROM 1890 TO 1895', 'FROM 1890 TO 1895'],
    ['from 1890', 'FROM 1890', 'FROM 1890'],
    ['to 1895', 'TO 1895', 'TO 1895'],
    ['05/28/1960', '28 MAY 1960', '28 MAY 1960'],
    ['1750/51', '1750/51', '1750'],
    ['44 BC', '44 B.C.', '44 BCE'],
    ['Julian 5 Sep 1700', '@#DJULIAN@ 5 SEP 1700', 'JULIAN 5 SEP 1700'],
    [
      'BET @#DJULIAN@ 1700 AND @#DJULIAN@ 1701',
      'BET @#DJULIAN@ 1700 AND @#DJULIAN@ 1701',
      'BET JULIAN 1700 AND JULIAN 1701',
    ],
    ['@#DHEBREW@ 1 TSH 5700', '@#DHEBREW@ 1 TSH 5700', 'HEBREW 1 TSH 5700'],
    ['@#DFRENCH R@ 1 VEND 1', '@#DFRENCH R@ 1 VEND 1', 'FRENCH_R 1 VEND 1'],
    ['@#DUNKNOWN@ 1900', '@#DUNKNOWN@ 1900', '1900'],
    ['INT 5 SEP 1941 (fifth)', 'INT 5 SEP 1941 (fifth)', '5 SEP 1941'],
    ['INT 1941', 'INT 1941', '1941'],
    ['unknown', '(unknown)', ''],
    ['(when the war ended)', '(when the war ended)', ''],
    ['a (b) c', '(a b c)', ''],
    ['', '', ''],
  ])('%j -> 5.5.1 %j, 7 %j', (input, v551, v7) => {
    expect(toGedcom(input)).toBe(v551);
    expect(toGedcom(parseDate(input), '5.5.1')).toBe(v551);
    expect(toGedcom(input, '7')).toBe(v7);
  });
});

describe('round trips', () => {
  const shape = (p: ParsedDate) => ({
    qualifier: p.qualifier,
    start: p.start,
    end: p.end,
    calendar: p.calendar,
    sortKey: p.sortKey,
    sortKeyEnd: p.sortKeyEnd,
  });
  // GEDCOM 7 drops dual years and INT (the phrase moves to a PHRASE substructure).
  const as7 = (p: ParsedDate) => ({
    ...shape(p),
    qualifier: p.qualifier === 'interpreted' ? 'exact' : p.qualifier,
    start: p.start && { ...p.start, dualYear: undefined },
    sortKey: undefined,
  });

  it('formatDate output re-parses to the same date', () => {
    fc.assert(
      fc.property(arbDateText, (text) => {
        const parsed = parseDate(text);
        expect(parsed.valid).toBe(true);
        expect(shape(parseDate(formatDate(parsed)))).toEqual(shape(parsed));
      }),
    );
  });

  it('GEDCOM 5.5.1 output re-parses to the same date', () => {
    fc.assert(
      fc.property(arbDateText, (text) => {
        const parsed = parseDate(text);
        expect(shape(parseDate(toGedcom(parsed, '5.5.1')))).toEqual(shape(parsed));
      }),
    );
  });

  it('GEDCOM 7 output re-parses to the same date, minus dual years', () => {
    fc.assert(
      fc.property(arbDateText, (text) => {
        const parsed = parseDate(text);
        expect(as7(parseDate(toGedcom(parsed, '7')))).toEqual(as7(parsed));
      }),
    );
  });

  it('formatting is idempotent', () => {
    fc.assert(
      fc.property(fc.oneof(arbDateText, fc.string()), (text) => {
        const once = formatDate(text);
        expect(formatDate(once)).toBe(once);
      }),
    );
  });
});

describe('toGedcom output safety', () => {
  // Every byte of a DATE payload ends up on one GEDCOM line, so user text must
  // not be able to start a new line, smuggle control characters or a bare `@`.
  const CAL551 = '(?:@#D(?:JULIAN|HEBREW|FRENCH R|UNKNOWN)@ )?';
  const CAL7 = '(?:(?:JULIAN|HEBREW|FRENCH_R) )?';
  const grammar = (cal: string, era: string, dual: string) => {
    const point = `${cal}(?:\\d{1,2} )?(?:[A-Z]{3,4} )?\\d{1,4}${dual}(?: ${era})?`;
    return new RegExp(
      `^(?:(?:ABT |CAL |EST |BEF |AFT |FROM |TO |INT )?${point}|BET ${point} AND ${point}|FROM ${point} TO ${point})$`,
    );
  };
  const DATE_551 = grammar(CAL551, 'B\\.C\\.', '(?:/\\d{2})?');
  const DATE_7 = grammar(CAL7, 'BCE', '');
  const PHRASE = /^\((?:[^()@\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|@@)+\)$/u;
  const INT_551 = new RegExp(`^INT .+ \\((?:[^()@\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]|@@)+\\)$`, 'u');

  const check551 = (out: string) => {
    expect(out).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
    expect(out === '' || DATE_551.test(out) || PHRASE.test(out) || INT_551.test(out)).toBe(true);
  };
  const check7 = (out: string) => {
    expect(out === '' || DATE_7.test(out)).toBe(true);
  };

  it.each([
    ['unknown\r\n0 @I1@ INDI', '(unknown 0 @@I1@@ INDI)'],
    ['INT 1941 (war\n1 NOTE injected)', 'INT 1941 (war 1 NOTE injected)'],
    ['INT 1941 (email a@b.example)', 'INT 1941 (email a@@b.example)'],
    ['(a b\u0000c​d)', '(a b c d)'],
    ['\u0085\u000b', ''],
  ])('%j -> %j', (input, output) => {
    expect(toGedcom(input)).toBe(output);
    check551(toGedcom(input));
    check7(toGedcom(input, '7'));
  });

  it('falls back to a safe phrase for hand-built dates with bad parts', () => {
    const forged = {
      ...parseDate('1941'),
      text: 'x\n0 TRLR',
      start: { year: '1941\n0 TRLR' as unknown as number },
    };
    expect(toGedcom(forged)).toBe('(x 0 TRLR)');
    expect(toGedcom(forged, '7')).toBe('');
    const badMonth = { ...parseDate('SEP 1941'), start: { year: 1941, month: 13 } };
    expect(toGedcom(badMonth)).toBe('(SEP 1941)');
    const badDay = { ...parseDate('5 SEP 1941'), start: { year: 1941, month: 9, day: 31 } };
    expect(toGedcom(badDay)).toBe('(5 SEP 1941)');
    const badDual = { ...parseDate('1750/51'), start: { year: 1750, dualYear: 1760 } };
    expect(toGedcom(badDual)).toBe('(1750/51)');
    const badEnd = { ...parseDate('BET 1890 AND 1895'), end: { year: 0 } };
    expect(toGedcom(badEnd)).toBe('(BET 1890 AND 1895)');
    const noMonth = { ...parseDate('5 SEP 1941'), start: { year: 1941, day: 5 } };
    expect(toGedcom(noMonth)).toBe('(5 SEP 1941)');
    const badCalendar = { ...parseDate('1941'), calendar: 'x\n' as unknown as 'gregorian' };
    expect(toGedcom(badCalendar)).toBe('1941');
    const badPhrase = { ...parseDate('INT 1941'), phrase: 'a)\r\n0 @X@ NOTE' };
    expect(toGedcom(badPhrase)).toBe('INT 1941 (a 0 @@X@@ NOTE)');
  });

  it('is always one line in the GEDCOM date grammar or a safe phrase', () => {
    const noisy = fc.string({
      unit: fc.oneof(
        fc.constantFrom('\r', '\n', ' ', '\u0000', '\u0085', '@', '(', ')', ' ', '/', '.'),
        fc.constantFrom(...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
        fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }),
      ),
      maxLength: 60,
    });
    fc.assert(
      fc.property(fc.oneof(arbDateText, noisy, fc.string({ unit: 'binary' })), (text) => {
        check551(toGedcom(text));
        check7(toGedcom(text, '7'));
      }),
      { numRuns: 2000 },
    );
  });
});
