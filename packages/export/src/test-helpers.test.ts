import { describe, expect, it } from 'vitest';
import { gedcom7Problems } from './test-helpers';

const withDate = (date: string) =>
  ['0 HEAD', '1 GEDC', '2 VERS 7.0', '0 @I1@ INDI', '1 BIRT', `2 DATE ${date}`, '0 TRLR', ''].join(
    '\n',
  );

describe('gedcom7Problems DATE grammar', () => {
  it.each([
    '',
    '5 SEP 1941',
    'GREGORIAN 5 SEP 1941',
    'JULIAN 1 MAR 1700',
    'JULIAN 15 MAR 44 BCE',
    '44 BCE',
    'HEBREW 1 TSH 5780',
    'HEBREW ADS 5784',
    'HEBREW 5780',
    'FRENCH_R 1 VEND 10',
    'FRENCH_R 5 COMP 3',
    'ABT FRENCH_R 5',
    'BEF JULIAN 1752',
    'AFT HEBREW ELL 5700',
    'BET JULIAN 1700 AND JULIAN 1701',
    'BET JULIAN 1 JAN 1751 AND 1 JAN 1753',
    'FROM HEBREW TSH 5700 TO HEBREW ELL 5710',
    'FROM 1700',
    'TO JULIAN 1710',
  ])('accepts %j', (date) => {
    expect(gedcom7Problems(withDate(date))).toEqual([]);
  });

  it.each([
    '@#DJULIAN@ 1 MAR 1700',
    'JULIAN',
    'HEBREW 1 JAN 5780',
    'JULIAN 1 TSH 1700',
    'GREGORIAN 1 VEND 10',
    'FRENCH_R 1 SEP 10',
    'HEBREW 5780 BCE',
    'FRENCH_R 10 BCE',
    '1750/51',
    '44 B.C.',
    'INT 1941',
    'BET JULIAN 1700',
    'FROM 1700 TO',
    'julian 1 MAR 1700',
    '1 MAR',
  ])('rejects %j', (date) => {
    expect(gedcom7Problems(withDate(date))).toEqual([expect.stringMatching(/^bad DATE/)]);
  });
});
