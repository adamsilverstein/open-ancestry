/** Issue #33: century and decade forms and hyphenated ranges with a qualifier. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { inferLiving } from '../living';
import { formatDate, parseDate, toGedcom } from './index';
import { arbSpanDate } from './test-arbitraries';
import type { ParsedDate } from './types';

const shape = (p: ParsedDate) => ({
  qualifier: p.qualifier,
  start: p.start,
  end: p.end,
  sortKey: p.sortKey,
  sortKeyEnd: p.sortKeyEnd,
  valid: p.valid,
});

describe('decades, centuries and hyphenated ranges', () => {
  // [input, the GEDCOM date it means]
  it.each<[string, string]>([
    // Centuries: "1700s" is the eighteenth century, not the decade 1700-1709.
    ['1700s', 'BET 1700 AND 1799'],
    ['1800s', 'BET 1800 AND 1899'],
    ['1800S', 'BET 1800 AND 1899'],
    ['900s', 'BET 900 AND 999'],
    // Decades.
    ['1850s', 'BET 1850 AND 1859'],
    ['1910s', 'BET 1910 AND 1919'],
    ["1850's", 'BET 1850 AND 1859'],
    ['1850s-1860s', 'BET 1850 AND 1869'],
    // Hyphenated ranges after Bet.
    ['Bet. 1850-1860', 'BET 1850 AND 1860'],
    ['bet 1850-1860', 'BET 1850 AND 1860'],
    ['Between 1850–1860', 'BET 1850 AND 1860'],
    ['Bet. 1850-60', 'BET 1850 AND 1860'],
    ['Bet. 1850s', 'BET 1850 AND 1859'],
    // Approximate ranges keep their span (GEDCOM has no "about between").
    ['Abt. 1850-1860', 'BET 1850 AND 1860'],
    ['abt 1850-60', 'BET 1850 AND 1860'],
    ['c. 1850s', 'BET 1850 AND 1859'],
    ['circa 1700s', 'BET 1700 AND 1799'],
    ['Est. 1850-1860', 'BET 1850 AND 1860'],
    ['Cal 1850-1860', 'BET 1850 AND 1860'],
    // Before a span is before its end; after a span is after its start.
    ['Bef. 1850-1860', 'BEF 1860'],
    ['bef 1850s', 'BEF 1859'],
    ['Aft. 1850-1860', 'AFT 1850'],
    ['aft 1700s', 'AFT 1700'],
    // 21st-century "00s" is the decade, as everyone means it.
    ['2000s', 'BET 2000 AND 2009'],
    ['abt 2000s', 'BET 2000 AND 2009'],
    ['1900s', 'BET 1900 AND 1999'],
    // Spans on either side of a written-out range.
    ['BET 1850s AND 1860s', 'BET 1850 AND 1869'],
    // A right side ending in 00s borrows the left side's granularity; any other is a decade.
    ['1660s-1700s', 'BET 1660 AND 1709'],
    ['1700s-1800s', 'BET 1700 AND 1899'],
    ['1700s-1750s', 'BET 1700 AND 1759'],
    ['1990s-2000s', 'BET 1990 AND 2009'],
    // 2000s is a decade everywhere (#52), even after a century.
    ['1900s-2000s', 'BET 1900 AND 2009'],
    ['BET 1900s AND 2000s', 'BET 1900 AND 2009'],
    ['FROM 1900s TO 2000s', 'FROM 1900 TO 2009'],
    ['BET 1660s AND 1700s', 'BET 1660 AND 1709'],
    ['BET 1700s AND 1800s', 'BET 1700 AND 1899'],
    ['Abt. 1660s-1700s', 'BET 1660 AND 1709'],
    ['Bef. 1660s-1700s', 'BEF 1709'],
  ])('%j means %s', (input, gedcom) => {
    const date = parseDate(input);
    expect(date.text).toBe(input);
    expect(shape(date)).toEqual(shape(parseDate(gedcom)));
    expect(date.valid).toBe(true);
  });

  it.each(['1850-09', '1700s and more', 'Bet. 1860-1850', 'abt 1850-1860-1870', '0s', '00s'])(
    '%j is not a span',
    (input) => {
      const date = parseDate(input);
      expect(date.qualifier === 'between' && date.end?.year !== date.start?.year).toBe(false);
    },
  );

  it.each(['1700s', '1850s', 'Bet. 1850-1860', 'Abt. 1850-60', 'c. 1850s', 'Bef. 1850-1860'])(
    '%j round-trips through GEDCOM and the display form',
    (input) => {
      const parsed = parseDate(input);
      for (const version of ['5.5.1', '7'] as const) {
        expect(shape(parseDate(toGedcom(parsed, version)))).toEqual(shape(parsed));
      }
      expect(shape(parseDate(formatDate(parsed)))).toEqual(shape(parsed));
    },
  );
});

describe('periods bounded by decades and centuries', () => {
  // [input, the GEDCOM date it means]
  it.each<[string, string]>([
    // A period from a span starts at its first year; to a span ends at its last (the
    // loose reading, as with BEF and AFT, so nothing is assumed beyond what was written).
    ['FROM 1850s', 'FROM 1850'],
    ['from 1850s', 'FROM 1850'],
    ["From 1850's", 'FROM 1850'],
    ['FROM 1700s', 'FROM 1700'],
    ['FROM 2000s', 'FROM 2000'],
    ['TO 1850s', 'TO 1859'],
    ['to 1700s', 'TO 1799'],
    ['TO 2000s', 'TO 2009'],
    // Both ends.
    ['FROM 1850s TO 1860s', 'FROM 1850 TO 1869'],
    ['FROM 1660s TO 1700s', 'FROM 1660 TO 1709'],
    // After a plain year the right side is read alone: 1900s is the century.
    ['FROM 1850 TO 1900s', 'FROM 1850 TO 1999'],
    ['BET 1850 AND 1800s', 'BET 1850 AND 1899'],
    ['FROM 1660s-1700s', 'FROM 1660 TO 1709'],
    ['TO 1660s-1700s', 'TO 1709'],
    ['FROM 1700s TO 1800s', 'FROM 1700 TO 1899'],
    ['FROM 1850 TO 1860s', 'FROM 1850 TO 1869'],
    ['FROM 1850s TO 1855', 'FROM 1850 TO 1855'],
    ['FROM 2000s TO 2010s', 'FROM 2000 TO 2019'],
    // A span written as one range after FROM is the whole period.
    ['FROM 1850s-1860s', 'FROM 1850 TO 1869'],
    ['FROM 1850-1860', 'FROM 1850 TO 1860'],
    ['FROM 1850-60', 'FROM 1850 TO 1860'],
  ])('%j means %s', (input, gedcom) => {
    const date = parseDate(input);
    expect(date.text).toBe(input);
    expect(date.valid).toBe(true);
    expect(shape(date)).toEqual(shape(parseDate(gedcom)));
  });

  it.each([
    'FROM 1860s TO 1850s',
    'FROM 1860s TO 1855',
    'FROM 1870 TO 1850s',
    'FROM 1860-1850',
    'TO 0s',
  ])('%j runs backwards or is no span, so it stays text', (input) => {
    expect(parseDate(input).qualifier).toBe('text');
  });

  it.each([
    'FROM 1850s',
    'TO 1850s',
    'FROM 1850s TO 1860s',
    'FROM 1700s TO 1800s',
    'TO 2000s',
    'FROM 1850-60',
  ])('%j round-trips through GEDCOM and the display form', (input) => {
    const parsed = parseDate(input);
    for (const version of ['5.5.1', '7'] as const) {
      expect(shape(parseDate(toGedcom(parsed, version)))).toEqual(shape(parsed));
    }
    expect(shape(parseDate(formatDate(parsed)))).toEqual(shape(parsed));
  });
});

describe('span date properties', () => {
  it('every generated span date parses to the GEDCOM date it means', () => {
    fc.assert(
      fc.property(arbSpanDate, ({ text, means }) => {
        const date = parseDate(text);
        expect(date.valid, text).toBe(true);
        expect(shape(date), text).toEqual(shape(parseDate(means)));
      }),
      { numRuns: 2000 },
    );
  });

  it('keeps sort keys ordered and inside the years written', () => {
    fc.assert(
      fc.property(arbSpanDate, ({ text }) => {
        const date = parseDate(text);
        if (date.end) {
          expect(date.sortKey).toBeLessThanOrEqual(date.sortKeyEnd!);
          expect(date.start!.year).toBeLessThanOrEqual(date.end.year);
          expect(date.sortKey).toBe(parseDate(`BEF ${date.start!.year}`).sortKey + 1);
          expect(date.sortKeyEnd).toBe(parseDate(`AFT ${date.end.year}`).sortKey - 1);
        }
        const years = [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
        expect(Math.floor(date.sortKey / 10000)).toBeGreaterThanOrEqual(Math.min(...years));
      }),
      { numRuns: 2000 },
    );
  });

  it('parse, format and parse again give the same date', () => {
    fc.assert(
      fc.property(arbSpanDate, ({ text }) => {
        const parsed = parseDate(text);
        for (const version of ['5.5.1', '7'] as const) {
          expect(shape(parseDate(toGedcom(parsed, version))), `${text} ${version}`).toEqual(
            shape(parsed),
          );
        }
        expect(shape(parseDate(formatDate(parsed))), text).toEqual(shape(parsed));
      }),
      { numRuns: 2000 },
    );
  });

  it.each(['TO 1850s TO 1860s', 'TO 1850 TO 1860', 'FROM 1850s FROM 1860s'])(
    '%j repeats its keyword, so it stays text',
    (input) => {
      expect(parseDate(input).qualifier).toBe('text');
    },
  );

  it('TO a range keeps its end: the period ends there, wherever it began', () => {
    expect(shape(parseDate('TO 1850-60'))).toEqual(shape(parseDate('TO 1860')));
    expect(shape(parseDate('TO 1850s-1860s'))).toEqual(shape(parseDate('TO 1869')));
  });
});

describe('inverted ranges', () => {
  it.each(['BEF 1850-13', 'AFT 1850-13', 'BEF 1950-1913', 'abt 1950-13', 'Bet. 1950-13'])(
    '%j stays text whatever qualifier comes first',
    (input) => {
      expect(parseDate(input).qualifier).toBe('text');
    },
  );

  it('never reads a typed range as earlier than it is written', () => {
    const today = new Date('2026-10-14T12:00:00Z');
    fc.assert(
      fc.property(
        fc.constantFrom('', 'BEF ', 'AFT ', 'ABT ', 'BET ', 'c. ', 'Est. '),
        fc.integer({ min: 1000, max: 2026 }),
        fc.oneof(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 1000, max: 2026 })),
        (qualifier, start, end) => {
          const tail = end < 100 ? String(end).padStart(2, '0') : String(end);
          const date = parseDate(`${qualifier}${start}-${tail}`);
          if (date.valid && date.end)
            expect(date.end.year).toBeGreaterThanOrEqual(date.start!.year);
          // Fail closed: when the latest year written is recent, the person stays living.
          const full = end < 100 ? end + start - (start % 100) : end;
          if (Math.max(start, full) > 1926) {
            expect(inferLiving({ birth: `${qualifier}${start}-${tail}` }, today).living).toBe(true);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('living inference with wide ranges', () => {
  const today = new Date('2026-10-14T12:00:00Z');

  it.each([
    // The latest year of the range decides, so a wide range stays living.
    ['1900s', true],
    ['abt 1920-1930', true],
    ['c. 1920s', true],
    ['Bef. 1920-1930', true],
    ['1800s', false],
    ['Bet. 1850-1860', false],
    ['Aft. 1800-1810', true],
    ['BEF 1950-13', true],
    ['2000s', true],
  ])('born %j: living %s', (birth, living) => {
    expect(inferLiving({ birth }, today).living).toBe(living);
  });
});
