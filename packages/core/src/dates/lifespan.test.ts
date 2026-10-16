import { describe, expect, it } from 'vitest';
import { formatLifespan, lifeDate, parseDate } from './index';

/** A stored event brief, as the database keeps a parsed date. */
const brief = (text: string) => {
  const d = parseDate(text);
  return { dateSort: d.sortKey, dateQualifier: d.qualifier, dateText: text };
};

describe('lifeDate', () => {
  it.each([
    ['5 SEP 1941', { year: 1941 }],
    ['ABT 1842', { year: 1842, qualifier: 'abt' }],
    ['Abt. 1842', { year: 1842, qualifier: 'abt' }],
    ['BEF 1920', { year: 1920, qualifier: 'bef' }],
    ['AFT 1950', { year: 1950, qualifier: 'aft' }],
    ['EST 1800', { year: 1800, qualifier: 'est' }],
    ['CAL 1840', { year: 1840, qualifier: 'cal' }],
    // A range reads as about its middle year; an open period as before or after its bound.
    ['BET 1870 AND 1872', { year: 1871, qualifier: 'abt' }],
    ['FROM 1870 TO 1880', { year: 1875, qualifier: 'abt' }],
    ['1850s', { year: 1854, qualifier: 'abt' }],
    ['FROM 1890', { year: 1890, qualifier: 'aft' }],
    ['TO 1890', { year: 1890, qualifier: 'bef' }],
    ['05/28/1960', { year: 1960 }],
    ['44 B.C.', { year: -44 }],
  ])('%s -> %j', (text, date) => {
    expect(lifeDate(brief(text))).toEqual(date);
  });

  it('falls back to the first year of a range without its text', () => {
    expect(lifeDate({ dateSort: 18700101, dateQualifier: 'between' })).toEqual({
      year: 1870,
      qualifier: 'abt',
    });
  });

  it('is undefined without a sortable date', () => {
    expect(lifeDate(null)).toBeUndefined();
    expect(lifeDate({ dateSort: null, dateQualifier: 'text' })).toBeUndefined();
  });
});

describe('formatLifespan', () => {
  const life = (birth?: string, death?: string, living = false) => ({
    birth: birth ? lifeDate(brief(birth)) : undefined,
    death: death ? lifeDate(brief(death)) : undefined,
    living,
  });
  it.each([
    [life('3 MAR 1846', 'BEF 1920'), '1846–bef. 1920'],
    [life('BET 1870 AND 1872', 'AFT 1950'), 'abt. 1871–aft. 1950'],
    [life('Abt. 1842', '4 NOV 1911'), 'abt. 1842–1911'],
    [life('CAL 1840', '1899'), 'cal. 1840–1899'],
    [life('1947', undefined, true), '1947–Living'],
    [life(undefined, undefined, true), 'Living'],
    [life('1820'), 'b. 1820'],
    [life(undefined, '1880'), 'd. 1880'],
    [life('44 B.C.', '10'), '44 B.C.–10'],
    [life(), ''],
  ])('%j -> %s', (lifespan, text) => {
    expect(formatLifespan(lifespan)).toBe(text);
  });
});
