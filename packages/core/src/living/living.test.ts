import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseDate } from '../dates';
import { inferLiving } from './index';
import type { LivingInput, LivingResult } from './index';

const today = new Date('2026-10-14T12:00:00Z');

describe('inferLiving', () => {
  it.each<[string, LivingInput, Partial<LivingResult>]>([
    ['no data at all', {}, { living: true, reason: 'no-dates', estimated: false }],
    [
      'born 50 years ago',
      { birth: '1976' },
      { living: true, reason: 'birth-within-threshold', birthYear: 1976 },
    ],
    ['born 99 years ago', { birth: '1927' }, { living: true, reason: 'birth-within-threshold' }],
    [
      'born exactly 100 years ago',
      { birth: '1926' },
      { living: false, reason: 'birth-beyond-threshold' },
    ],
    [
      'born 126 years ago',
      { birth: '5 SEP 1900' },
      { living: false, reason: 'birth-beyond-threshold', birthYear: 1900 },
    ],
    ['about 96 years ago', { birth: 'ABT 1930' }, { living: true }],
    [
      'recent birth with death date',
      { birth: '1950', death: '2000' },
      { living: false, reason: 'death-facts' },
    ],
    [
      'recent birth with undated death',
      { birth: '1950', death: '' },
      { living: false, reason: 'death-facts' },
    ],
    [
      'recent birth with death flag',
      { birth: '1950', hasDeathFacts: true },
      { living: false, reason: 'death-facts' },
    ],
    [
      'recent birth with burial',
      { birth: '1950', burial: '2000' },
      { living: false, reason: 'death-facts' },
    ],
    ['unparseable birth, no relatives', { birth: 'unknown' }, { living: true, reason: 'no-dates' }],
    [
      'one parent born 1890 bounds birth by 1940',
      { parentBirths: ['1890'] },
      { living: true, reason: 'birth-within-threshold', estimated: true, birthYear: 1940 },
    ],
    [
      'one old parent is not enough',
      { parentBirths: ['1850'] },
      { living: true, reason: 'insufficient-evidence', estimated: true, birthYear: 1900 },
    ],
    [
      'two old parents agree',
      { parentBirths: ['1850', '1855'] },
      { living: false, reason: 'birth-beyond-threshold', estimated: true, birthYear: 1905 },
    ],
    [
      'two old relatives inside the margin',
      { parentBirths: ['1855', '1870'] },
      { living: true, reason: 'insufficient-evidence', birthYear: 1920 },
    ],
    [
      'single mistyped child date',
      { childBirths: ['1801'] },
      { living: true, reason: 'insufficient-evidence', birthYear: 1789 },
    ],
    [
      'parent born 1950',
      { parentBirths: ['1950'] },
      { living: true, estimated: true, birthYear: 2000 },
    ],
    [
      'child born 1960',
      { childBirths: ['1960'] },
      { living: true, estimated: true, birthYear: 1948 },
    ],
    [
      'children born 1900 and 1905',
      { childBirths: ['1900', '1905'] },
      { living: false, estimated: true, birthYear: 1893 },
    ],
    [
      'spouse born 1920 alone',
      { spouseBirths: ['1920'] },
      { living: true, reason: 'birth-within-threshold', birthYear: 1940 },
    ],
    [
      'old spouse alone',
      { spouseBirths: ['1880'] },
      { living: true, reason: 'insufficient-evidence', birthYear: 1900 },
    ],
    [
      'spouse born 1940',
      { spouseBirths: [parseDate('1940')] },
      { living: true, estimated: true, birthYear: 1960 },
    ],
    [
      'old parent and spouse agree',
      { parentBirths: ['1850'], spouseBirths: ['1870'] },
      { living: false, birthYear: 1900 },
    ],
    [
      'latest estimate wins',
      { parentBirths: ['1850', '1855'], childBirths: ['1990'] },
      { living: true, estimated: true, birthYear: 1978 },
    ],
    [
      'undated relatives',
      { parentBirths: ['unknown'], childBirths: [] },
      { living: true, reason: 'no-dates' },
    ],
    [
      'own birth beats relatives',
      { birth: '1890', childBirths: ['1990'] },
      { living: false, estimated: false },
    ],
  ])('%s', (_label, input, expected) => {
    expect(inferLiving(input, today)).toMatchObject(expected);
  });

  it('honours a custom threshold', () => {
    expect(inferLiving({ birth: '1920' }, today, 110).living).toBe(true);
    expect(inferLiving({ birth: '1920' }, today, 100).living).toBe(false);
  });

  it('defaults today to the current date', () => {
    expect(inferLiving({ birth: String(new Date().getFullYear() - 1) }).living).toBe(true);
  });

  it.each<[string, LivingInput]>([
    ['open-ended birth', { birth: 'AFT 1800' }],
    ['open-ended FROM birth', { birth: 'FROM 1800' }],
    ['range birth uses its latest year', { birth: 'BET 1800 AND 1950' }],
    ['future birth', { birth: '2400' }],
    [
      'null death and burial',
      { birth: '1950', death: null, burial: null } as unknown as LivingInput,
    ],
    ['non-boolean death flag', { hasDeathFacts: 'true' } as unknown as LivingInput],
    ['relatives as a string, not a list', { parentBirths: '1800' } as unknown as LivingInput],
    ['open-ended parent birth', { parentBirths: ['AFT 1800'] }],
    ['decade birth', { birth: '1920s' }],
    ['year-range birth', { birth: '1900-2010' }],
    ['FROM..TO birth', { birth: 'FROM 1900 TO 2000' }],
    ['BET birth', { birth: 'BET 1900 AND 2000' }],
    ['open-ended child births', { childBirths: ['AFT 1900', 'AFT 1850'] }],
    ['ranged child births', { childBirths: ['BET 1900 AND 1990', '1910'] }],
    ['forged parsed birth', { birth: { ...parseDate('1800'), sortKey: NaN } }],
    ['forged invalid parsed birth', { birth: { ...parseDate('1800'), valid: false } }],
    ['numeric birth', { birth: 1800 } as unknown as LivingInput],
  ])('fails closed: %s', (_label, input) => {
    expect(inferLiving(input, today).living).toBe(true);
  });

  it('fails closed on bad today, threshold or input', () => {
    expect(inferLiving({ birth: '1800' }, new Date('nope')).living).toBe(true);
    expect(inferLiving({ birth: '1800' }, 'today' as unknown as Date).living).toBe(true);
    expect(inferLiving({ birth: '1950' }, today, NaN).living).toBe(true);
    expect(inferLiving({ birth: '1950' }, today, 0).living).toBe(true);
    expect(inferLiving({ birth: '1950' }, today, -5).living).toBe(true);
    expect(inferLiving(null as unknown as LivingInput, today).living).toBe(true);
  });

  it('still uses positive evidence', () => {
    expect(inferLiving({ birth: 'BEF 1900' }, today).living).toBe(false);
    expect(inferLiving({ birth: '1800' }, today, NaN).living).toBe(false);
  });
});

describe('inferLiving fails closed (properties)', () => {
  const noDeath = {
    death: fc.constantFrom(undefined, null),
    burial: fc.constantFrom(undefined, null),
  };
  const anyDate = fc.oneof(
    fc.anything(),
    fc.string(),
    fc.integer().map(String),
    fc.constant('AFT 1700'),
  );
  const arbInput = fc.record(
    {
      birth: anyDate,
      hasDeathFacts: fc.oneof(
        fc.constant(false),
        fc.anything().filter((v) => v !== true),
      ),
      parentBirths: fc.oneof(fc.array(anyDate), fc.anything()),
      spouseBirths: fc.oneof(fc.array(anyDate), fc.anything()),
      childBirths: fc.oneof(fc.array(anyDate), fc.anything()),
      ...noDeath,
    },
    { requiredKeys: [] },
  ) as fc.Arbitrary<LivingInput>;
  const arbToday = fc.oneof(fc.date(), fc.constant(new Date('nope')), fc.anything());
  const arbThreshold = fc.oneof(fc.integer({ min: -10, max: 200 }), fc.double());

  it('only reports deceased when a birth year is at least the threshold ago', () => {
    fc.assert(
      fc.property(arbInput, arbToday, arbThreshold, (input, now, threshold) => {
        const result = inferLiving(input, now as Date, threshold);
        if (result.living) return;
        const t = Number.isFinite(threshold) && threshold > 0 ? threshold : 100;
        expect(result.reason).toBe('birth-beyond-threshold');
        expect(Number.isFinite(result.birthYear)).toBe(true);
        // An undefined argument falls back to the default of the current date.
        const current = (now === undefined ? new Date() : (now as Date)).getFullYear();
        expect(current - result.birthYear!).toBeGreaterThanOrEqual(t);
      }),
      { numRuns: 1000 },
    );
  });

  it('is always living when no date parses', () => {
    const noDate = fc.string().filter((s) => !parseDate(s).valid);
    fc.assert(
      fc.property(
        fc.record(
          {
            birth: noDate,
            parentBirths: fc.array(noDate),
            spouseBirths: fc.array(noDate),
            childBirths: fc.array(noDate),
          },
          { requiredKeys: [] },
        ),
        (input) => {
          expect(inferLiving(input, today)).toMatchObject({ living: true, reason: 'no-dates' });
        },
      ),
    );
  });

  it('is always living for a birth within the threshold, whatever the relatives', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1927, max: 3000 }), arbInput, (year, input) => {
        expect(inferLiving({ ...input, birth: String(year) }, today).living).toBe(true);
      }),
    );
  });

  it('never marks deceased from a single relative, however old', () => {
    const relative = fc.oneof(
      fc.integer({ min: 1, max: 3000 }).map(String),
      fc.integer({ min: 1, max: 3000 }).map((y) => `BEF ${y}`),
    );
    const kind = fc.constantFrom('parentBirths', 'spouseBirths', 'childBirths');
    fc.assert(
      fc.property(kind, relative, (k, date) => {
        expect(inferLiving({ [k]: [date] }, today).living).toBe(true);
      }),
    );
  });

  it('only marks deceased from relatives when two agree well past the threshold', () => {
    const years = fc.array(fc.integer({ min: 1, max: 3000 }), { maxLength: 4 });
    fc.assert(
      fc.property(years, years, years, (parents, spouses, children) => {
        const result = inferLiving(
          {
            parentBirths: parents.map(String),
            spouseBirths: spouses.map(String),
            childBirths: children.map(String),
          },
          today,
        );
        if (result.living) return;
        const bounds = [
          ...parents.map((y) => y + 50),
          ...spouses.map((y) => y + 20),
          ...children.map((y) => y - 12),
        ];
        expect(bounds.length).toBeGreaterThanOrEqual(2);
        expect(today.getFullYear() - Math.max(...bounds)).toBeGreaterThanOrEqual(110);
      }),
    );
  });
});
