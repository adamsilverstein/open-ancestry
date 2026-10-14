import { describe, expect, it } from 'vitest';
import { parseDate, UNDATED_SORT_KEY } from './index';
import type { Calendar, DatePoint, DateQualifier } from './types';

const d = (year: number, month?: number, day?: number, dualYear?: number): DatePoint => {
  const point: DatePoint = { year };
  if (month !== undefined) point.month = month;
  if (day !== undefined) point.day = day;
  if (dualYear !== undefined) point.dualYear = dualYear;
  return point;
};

type Row = [
  input: string,
  qualifier: DateQualifier,
  start?: DatePoint,
  end?: DatePoint,
  extra?: { calendar?: Calendar; phrase?: string },
];

const gedcom: Row[] = [
  ['5 SEP 1941', 'exact', d(1941, 9, 5)],
  ['05 SEP 1941', 'exact', d(1941, 9, 5)],
  ['SEP 1941', 'exact', d(1941, 9)],
  ['1941', 'exact', d(1941)],
  ['31 DEC 1999', 'exact', d(1999, 12, 31)],
  ['1 JAN 2000', 'exact', d(2000, 1, 1)],
  ['29 FEB 2000', 'exact', d(2000, 2, 29)],
  ['29 FEB 1904', 'exact', d(1904, 2, 29)],
  ['30 APR 1900', 'exact', d(1900, 4, 30)],
  ['950', 'exact', d(950)],
  ['1', 'exact', d(1)],
  ['ABT 1890', 'about', d(1890)],
  ['CAL 1890', 'calculated', d(1890)],
  ['EST 1890', 'estimated', d(1890)],
  ['BEF 1900', 'before', d(1900)],
  ['AFT 1900', 'after', d(1900)],
  ['ABT SEP 1890', 'about', d(1890, 9)],
  ['ABT 5 SEP 1890', 'about', d(1890, 9, 5)],
  ['BEF 5 SEP 1890', 'before', d(1890, 9, 5)],
  ['AFT JAN 1900', 'after', d(1900, 1)],
  ['EST 12 MAR 1850', 'estimated', d(1850, 3, 12)],
  ['CAL MAY 1777', 'calculated', d(1777, 5)],
  ['BET 1890 AND 1895', 'between', d(1890), d(1895)],
  ['BET 5 SEP 1890 AND 10 OCT 1895', 'between', d(1890, 9, 5), d(1895, 10, 10)],
  ['BET JAN 1900 AND MAR 1900', 'between', d(1900, 1), d(1900, 3)],
  ['BET 1890 AND 1890', 'between', d(1890), d(1890)],
  ['FROM 1890 TO 1895', 'from_to', d(1890), d(1895)],
  ['FROM 5 SEP 1890 TO OCT 1895', 'from_to', d(1890, 9, 5), d(1895, 10)],
  ['FROM 1890', 'from', d(1890)],
  ['TO 1895', 'to', d(1895)],
  ['FROM JUN 1918', 'from', d(1918, 6)],
  ['TO 11 NOV 1918', 'to', d(1918, 11, 11)],
  [
    'INT 5 SEP 1941 (fifth of September)',
    'interpreted',
    d(1941, 9, 5),
    undefined,
    { phrase: 'fifth of September' },
  ],
  ['INT 1941', 'interpreted', d(1941)],
  // A phrase after a plain date is read as an interpreted date.
  ['5 SEP 1941 (a note)', 'interpreted', d(1941, 9, 5), undefined, { phrase: 'a note' }],
  [
    'INT ABT 1941 (around the war)',
    'interpreted',
    d(1941),
    undefined,
    { phrase: 'around the war' },
  ],
  // Dual years.
  ['1750/51', 'exact', d(1750, undefined, undefined, 1751)],
  ['11 FEB 1731/32', 'exact', d(1731, 2, 11, 1732)],
  ['1699/00', 'exact', d(1699, undefined, undefined, 1700)],
  ['1750/1751', 'exact', d(1750, undefined, undefined, 1751)],
  ['ABT MAR 1689/90', 'about', d(1689, 3, undefined, 1690)],
  // Calendar escapes (5.5.1) and keywords (7).
  ['@#DJULIAN@ 5 SEP 1700', 'exact', d(1700, 9, 5), undefined, { calendar: 'julian' }],
  ['@#DJULIAN@ 29 FEB 1700', 'exact', d(1700, 2, 29), undefined, { calendar: 'julian' }],
  ['@#DGREGORIAN@ 5 SEP 1941', 'exact', d(1941, 9, 5), undefined, { calendar: 'gregorian' }],
  ['@#DHEBREW@ 1 TSH 5700', 'exact', d(5700, 1, 1), undefined, { calendar: 'hebrew' }],
  ['@#DHEBREW@ ELL 5700', 'exact', d(5700, 13), undefined, { calendar: 'hebrew' }],
  ['@#DFRENCH R@ 1 VEND 1', 'exact', d(1, 1, 1), undefined, { calendar: 'french_r' }],
  ['@#DFRENCH R@ COMP 5', 'exact', d(5, 13), undefined, { calendar: 'french_r' }],
  ['@#DUNKNOWN@ 1900', 'exact', d(1900), undefined, { calendar: 'unknown' }],
  ['@#DROMAN@ 1900', 'exact', d(1900), undefined, { calendar: 'unknown' }],
  ['JULIAN 5 SEP 1700', 'exact', d(1700, 9, 5), undefined, { calendar: 'julian' }],
  ['HEBREW 1 TSH 5700', 'exact', d(5700, 1, 1), undefined, { calendar: 'hebrew' }],
  ['FRENCH_R 1 VEND 1', 'exact', d(1, 1, 1), undefined, { calendar: 'french_r' }],
  ['GREGORIAN 5 SEP 1941', 'exact', d(1941, 9, 5), undefined, { calendar: 'gregorian' }],
  ['BET @#DJULIAN@ 1700 AND @#DJULIAN@ 1701', 'between', d(1700), d(1701), { calendar: 'julian' }],
  ['ABT @#DJULIAN@ 1700', 'about', d(1700), undefined, { calendar: 'julian' }],
  ['@#DJULIAN@ ABT 1700', 'about', d(1700), undefined, { calendar: 'julian' }],
  ['FROM JULIAN 1700 TO JULIAN 1710', 'from_to', d(1700), d(1710), { calendar: 'julian' }],
  // B.C.
  ['44 B.C.', 'exact', d(-44)],
  ['15 MAR 44 B.C.', 'exact', d(-44, 3, 15)],
  ['44 BC', 'exact', d(-44)],
  ['44 BCE', 'exact', d(-44)],
  ['ABT 500 BCE', 'about', d(-500)],
  ['44 B.C', 'exact', d(-44)],
  ['1 A.D.', 'exact', d(1)],
  ['ABT 1250 AD', 'about', d(1250)],
];

const human: Row[] = [
  ['05/28/1960', 'exact', d(1960, 5, 28)],
  ['5/28/1960', 'exact', d(1960, 5, 28)],
  ['28/05/1960', 'exact', d(1960, 5, 28)],
  ['05/06/1960', 'exact', d(1960, 5, 6)],
  ['12/31/1999', 'exact', d(1999, 12, 31)],
  ['31/12/1999', 'exact', d(1999, 12, 31)],
  ['5-28-1960', 'exact', d(1960, 5, 28)],
  ['5.9.1941', 'exact', d(1941, 9, 5)],
  ['12/1960', 'exact', d(1960, 12)],
  ['1941-09-05', 'exact', d(1941, 9, 5)],
  ['1941-9-5', 'exact', d(1941, 9, 5)],
  ['1941-09', 'exact', d(1941, 9)],
  ['2010-2019', 'between', d(2010), d(2019)],
  ['1890 - 1895', 'between', d(1890), d(1895)],
  ['1890–1895', 'between', d(1890), d(1895)],
  ['1890-95', 'between', d(1890), d(1895)],
  ['1890 to 1895', 'between', d(1890), d(1895)],
  ['1890s', 'between', d(1890), d(1899)],
  ['abt 1890', 'about', d(1890)],
  ['about 1890', 'about', d(1890)],
  ['About 1890', 'about', d(1890)],
  ['ABOUT 1890', 'about', d(1890)],
  ['Abt. 1890', 'about', d(1890)],
  ['abt. 1890', 'about', d(1890)],
  ['c. 1890', 'about', d(1890)],
  ['c 1890', 'about', d(1890)],
  ['c1890', 'about', d(1890)],
  ['C. 1890', 'about', d(1890)],
  ['ca. 1890', 'about', d(1890)],
  ['ca 1890', 'about', d(1890)],
  ['ca1890', 'about', d(1890)],
  ['circa 1890', 'about', d(1890)],
  ['Circa 1890', 'about', d(1890)],
  ['approx 1890', 'about', d(1890)],
  ['approx. 1890', 'about', d(1890)],
  ['approximately 1890', 'about', d(1890)],
  ['around 1890', 'about', d(1890)],
  ['~1890', 'about', d(1890)],
  ['~ 1890', 'about', d(1890)],
  ['abt Sep 1890', 'about', d(1890, 9)],
  ['about Sep 5, 1890', 'about', d(1890, 9, 5)],
  ['abt 05/28/1960', 'about', d(1960, 5, 28)],
  ['Sep 5, 1941', 'exact', d(1941, 9, 5)],
  ['Sept 5, 1941', 'exact', d(1941, 9, 5)],
  ['September 5, 1941', 'exact', d(1941, 9, 5)],
  ['September 5 1941', 'exact', d(1941, 9, 5)],
  ['September 5th, 1941', 'exact', d(1941, 9, 5)],
  ['Sep. 5, 1941', 'exact', d(1941, 9, 5)],
  ['5 Sept 1941', 'exact', d(1941, 9, 5)],
  ['5 September 1941', 'exact', d(1941, 9, 5)],
  ['5 sep 1941', 'exact', d(1941, 9, 5)],
  ['5th September 1941', 'exact', d(1941, 9, 5)],
  ['1st Jan 1900', 'exact', d(1900, 1, 1)],
  ['2nd Feb 1900', 'exact', d(1900, 2, 2)],
  ['3rd Mar 1900', 'exact', d(1900, 3, 3)],
  ['5 Sep. 1941', 'exact', d(1941, 9, 5)],
  ['5-Sep-1941', 'exact', d(1941, 9, 5)],
  ['Sep. 1941', 'exact', d(1941, 9)],
  ['sep 1941', 'exact', d(1941, 9)],
  ['September, 1941', 'exact', d(1941, 9)],
  ['1941 Sep 5', 'exact', d(1941, 9, 5)],
  ['Friday, 5 September 1941', 'exact', d(1941, 9, 5)],
  ['Fri 5 Sep 1941', 'exact', d(1941, 9, 5)],
  ['  5   SEP   1941  ', 'exact', d(1941, 9, 5)],
  ['5 SEP 1941.', 'exact', d(1941, 9, 5)],
  ['5 SEP 1941,', 'exact', d(1941, 9, 5)],
  ['5 SEP 1941;', 'exact', d(1941, 9, 5)],
  ['\t5 SEP 1941\n', 'exact', d(1941, 9, 5)],
  ['bef 1900', 'before', d(1900)],
  ['before 1900', 'before', d(1900)],
  ['Bef. 1900', 'before', d(1900)],
  ['Before Sep 1900', 'before', d(1900, 9)],
  ['aft 1900', 'after', d(1900)],
  ['after 1900', 'after', d(1900)],
  ['Aft. 1900', 'after', d(1900)],
  ['After 5 Sep 1900', 'after', d(1900, 9, 5)],
  ['est 1890', 'estimated', d(1890)],
  ['est. 1890', 'estimated', d(1890)],
  ['estimated 1890', 'estimated', d(1890)],
  ['cal 1890', 'calculated', d(1890)],
  ['calc 1890', 'calculated', d(1890)],
  ['calculated 1890', 'calculated', d(1890)],
  ['bet 1890 and 1895', 'between', d(1890), d(1895)],
  ['between 1890 and 1895', 'between', d(1890), d(1895)],
  ['Bet. 1890 and 1895', 'between', d(1890), d(1895)],
  ['bet. 1890 & 1895', 'between', d(1890), d(1895)],
  ['between 1890 - 1895', 'between', d(1890), d(1895)],
  ['btw 1890 and 1895', 'between', d(1890), d(1895)],
  ['from 1890 to 1895', 'from_to', d(1890), d(1895)],
  ['From Sep 1890 to Oct 1890', 'from_to', d(1890, 9), d(1890, 10)],
  ['from 1890', 'from', d(1890)],
  ['to 1895', 'to', d(1895)],
  [
    'int. 5 Sep 1941 (fifth of September)',
    'interpreted',
    d(1941, 9, 5),
    undefined,
    { phrase: 'fifth of September' },
  ],
  ['Julian 5 Sep 1700', 'exact', d(1700, 9, 5), undefined, { calendar: 'julian' }],
];

const monthNames = [
  ['JAN', 'January'],
  ['FEB', 'February'],
  ['MAR', 'March'],
  ['APR', 'April'],
  ['MAY', 'May'],
  ['JUN', 'June'],
  ['JUL', 'July'],
  ['AUG', 'August'],
  ['SEP', 'September'],
  ['OCT', 'October'],
  ['NOV', 'November'],
  ['DEC', 'December'],
] as const;
const months: Row[] = monthNames.flatMap(([abbr, full], i) => [
  [`10 ${abbr} 1900`, 'exact', d(1900, i + 1, 10)] as Row,
  [`${full} 1900`, 'exact', d(1900, i + 1)] as Row,
]);

const hebrewMonths = [
  'TSH',
  'CSH',
  'KSL',
  'TVT',
  'SHV',
  'ADR',
  'ADS',
  'NSN',
  'IYR',
  'SVN',
  'TMZ',
  'AAV',
  'ELL',
];
const hebrew: Row[] = hebrewMonths.map(
  (m, i) =>
    [
      `@#DHEBREW@ 2 ${m} 5700`,
      'exact',
      d(5700, i + 1, 2),
      undefined,
      { calendar: 'hebrew' },
    ] as Row,
);
const frenchMonths = [
  'VEND',
  'BRUM',
  'FRIM',
  'NIVO',
  'PLUV',
  'VENT',
  'GERM',
  'FLOR',
  'PRAI',
  'MESS',
  'THER',
  'FRUC',
  'COMP',
];
const french: Row[] = frenchMonths.map(
  (m, i) =>
    [`@#DFRENCH R@ 3 ${m} 7`, 'exact', d(7, i + 1, 3), undefined, { calendar: 'french_r' }] as Row,
);

const unparseable = [
  '',
  '   ',
  'unknown',
  'Unknown',
  'Deceased',
  'Living',
  'Y',
  'abc 1900',
  '5 FOO 1941',
  '5 SEP',
  'SEP',
  'ABT',
  'BEF',
  'FROM',
  'BET 1890',
  'BET 1890 AND',
  'BET AND 1895',
  'BET 1895 AND 1890',
  'FROM 1895 TO 1890',
  '2019-2010',
  '0',
  '99999',
  '29 FEB 1900',
  '29 FEB 1700',
  '31 APR 1900',
  '0 JAN 1900',
  '32 JAN 1900',
  'Sep 32, 1941',
  '13/13/1960',
  '00/10/1960',
  '1941-13-01',
  '1941-02-30',
  '1941-00',
  '1941 1942',
  '1750/52',
  '1750/',
  '@#DHEBREW@ 5 SEP 5700',
  '@#DJULIAN@ 1 TSH 1700',
  '@#DFRENCH R@ 1 VEND 1800/01',
  '@#DKLINGON@ 1900',
  'JULIAN',
  '<script>alert(1)</script>',
  '12345678901234567890',
  '5 5 5 5',
  'Sep 5 5 1941',
  '0 B.C.',
  '1890 to',
  '(no closing paren',
  'INT 1941 (unbalanced',
  'abt abt 1890',
  'BET @#DKLINGON@ 1700 AND 1701',
  'BET 1890 AND 1895 (a range with a note)',
];

describe('parseDate', () => {
  const rows = [...gedcom, ...human, ...months, ...hebrew, ...french];

  it('covers at least 150 table cases', () => {
    expect(rows.length + unparseable.length).toBeGreaterThanOrEqual(150);
  });

  it.each(rows)('%j -> %s', (input, qualifier, start, end, extra) => {
    const parsed = parseDate(input);
    expect(parsed.text).toBe(input);
    expect(parsed.qualifier).toBe(qualifier);
    expect(parsed.valid).toBe(true);
    expect(parsed.start).toEqual(start);
    expect(parsed.end).toEqual(end);
    expect(parsed.calendar).toBe(extra?.calendar ?? 'gregorian');
    expect(parsed.phrase).toBe(extra?.phrase);
    expect(Number.isInteger(parsed.sortKey)).toBe(true);
    expect(parsed.sortKey).not.toBe(UNDATED_SORT_KEY);
  });

  it.each(unparseable)('%j is preserved as text', (input) => {
    const parsed = parseDate(input);
    expect(parsed).toMatchObject({
      text: input,
      qualifier: 'text',
      valid: false,
      sortKey: UNDATED_SORT_KEY,
    });
    expect(parsed.start).toBeUndefined();
    expect(parsed.end).toBeUndefined();
  });

  it('keeps a bare date phrase', () => {
    expect(parseDate('(about when the war ended)')).toMatchObject({
      qualifier: 'text',
      valid: false,
      phrase: 'about when the war ended',
    });
  });

  it('never throws on hostile input', () => {
    for (const input of [null, undefined, 42, {}, 'x'.repeat(100_000), '\u0000', '\ud800']) {
      expect(() => parseDate(input as unknown as string)).not.toThrow();
    }
    expect(parseDate(undefined as unknown as string)).toMatchObject({
      text: '',
      qualifier: 'text',
    });
  });

  it('flags numeric dates that could be read either way', () => {
    expect(parseDate('05/06/1960').ambiguous).toBe(true);
    expect(parseDate('5.6.1960')).toMatchObject({ ambiguous: true, start: { month: 6, day: 5 } });
    expect(parseDate('abt 05/06/1960').ambiguous).toBe(true);
    expect(parseDate('BET 05/06/1960 AND 1970').ambiguous).toBe(true);
    expect(parseDate('05/05/1960').ambiguous).toBeUndefined();
    expect(parseDate('05/28/1960').ambiguous).toBeUndefined();
    expect(parseDate('5 SEP 1941').ambiguous).toBeUndefined();
  });
});
