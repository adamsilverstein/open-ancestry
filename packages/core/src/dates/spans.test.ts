/** Issue #33: century and decade forms and hyphenated ranges with a qualifier. */
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
  ])('born %j: living %s', (birth, living) => {
    expect(inferLiving({ birth }, today).living).toBe(living);
  });
});
