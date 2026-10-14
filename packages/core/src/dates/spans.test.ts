/** Issue #33: century and decade forms and hyphenated ranges with a qualifier. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { inferLiving } from '../living';
import { formatDate, parseDate, toGedcom } from './index';
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
