import { describe, expect, it } from 'vitest';
import {
  displayName,
  formatName,
  initials,
  normalizeForSearch,
  parseName,
  phoneticKeys,
  soundex,
  sortName,
  doubleMetaphone,
} from './index';
import type { PersonName } from './index';

const name = (parts: Partial<PersonName>): PersonName => ({
  prefix: '',
  given: '',
  nickname: '',
  surname: '',
  suffix: '',
  ...parts,
});

describe('parseName', () => {
  it.each<[string, Partial<PersonName>]>([
    ['John Henry /Smith/', { given: 'John Henry', surname: 'Smith' }],
    ['John /Smith/ Jr.', { given: 'John', surname: 'Smith', suffix: 'Jr.' }],
    ['John /Smith/ III', { given: 'John', surname: 'Smith', suffix: 'III' }],
    ['/Smith/', { surname: 'Smith' }],
    ['John //', { given: 'John' }],
    ['John', { given: 'John' }],
    ['John Smith', { given: 'John', surname: 'Smith' }],
    ['John Henry Smith Jr', { given: 'John Henry', surname: 'Smith', suffix: 'Jr' }],
    ['Dr. John /Smith/', { prefix: 'Dr.', given: 'John', surname: 'Smith' }],
    ['Rev John Smith', { prefix: 'Rev', given: 'John', surname: 'Smith' }],
    ['John "Jack" /Smith/', { given: 'John', nickname: 'Jack', surname: 'Smith' }],
    ['  John   Henry  /Smith/  ', { given: 'John Henry', surname: 'Smith' }],
    ['Anna /van der Berg/', { given: 'Anna', surname: 'van der Berg' }],
    ['John /Smith', { given: 'John', surname: 'Smith' }],
    ['María José /García López/', { given: 'María José', surname: 'García López' }],
    ['', {}],
    ['   ', {}],
  ])('%j', (input, expected) => {
    expect(parseName(input)).toEqual(name(expected));
  });

  it('never throws on non-string input', () => {
    expect(parseName(undefined as unknown as string)).toEqual(name({}));
  });
});

describe('name formats', () => {
  const full = name({ prefix: 'Dr.', given: 'John Henry', nickname: 'Jack', surname: 'Smith', suffix: 'Jr.' });

  it.each<[PersonName | string, string, string, string, string]>([
    // input, display (given first), surname first, sort, initials
    [full, 'Dr. John Henry Smith Jr.', 'Smith John Henry Jr.', 'Smith, John Henry Jr.', 'JS'],
    ['John Henry /Smith/', 'John Henry Smith', 'Smith John Henry', 'Smith, John Henry', 'JS'],
    ['/Smith/', 'Smith', 'Smith', 'Smith', 'S'],
    ['John Henry //', 'John Henry', 'John Henry', 'John Henry', 'JH'],
    ['émile /zola/', 'émile zola', 'zola émile', 'zola, émile', 'ÉZ'],
    ['', '', '', '', ''],
  ])('%j', (input, display, surnameFirst, sort, init) => {
    expect(displayName(input)).toBe(display);
    expect(formatName(input, 'given-first')).toBe(display);
    expect(formatName(input, 'surname-first')).toBe(surnameFirst);
    expect(formatName(input, 'sort')).toBe(sort);
    expect(sortName(input)).toBe(sort);
    expect(initials(input)).toBe(init);
  });
});

describe('normalizeForSearch', () => {
  it.each([
    ['Émile Zoë', 'emile zoe'],
    ['Müller', 'muller'],
    ['Straße', 'strasse'],
    ['Søren Kierkegård', 'soren kierkegard'],
    ['Æsir', 'aesir'],
    ['Łukasz', 'lukasz'],
    ["O'Brien", 'obrien'],
    ['Smith-Jones', 'smith jones'],
    ['  JOHN   smith ', 'john smith'],
    ['', ''],
  ])('%j -> %j', (input, output) => {
    expect(normalizeForSearch(input)).toBe(output);
  });
});

describe('soundex', () => {
  it.each([
    ['Robert', 'R163'],
    ['Rupert', 'R163'],
    ['Rubin', 'R150'],
    ['Ashcraft', 'A261'],
    ['Ashcroft', 'A261'],
    ['Tymczak', 'T522'],
    ['Pfister', 'P236'],
    ['Honeyman', 'H555'],
    ['Lee', 'L000'],
    ['Gutierrez', 'G362'],
    ['Jackson', 'J250'],
    ['Washington', 'W252'],
    ['Müller', 'M460'],
    ["O'Brien", 'O165'],
    ['smith', 'S530'],
    ['Smyth', 'S530'],
    ['', ''],
    ['123', ''],
  ])('%j -> %j', (input, code) => {
    expect(soundex(input)).toBe(code);
  });
});

describe('doubleMetaphone', () => {
  it.each([
    ['Smith', ['SM0', 'XMT']],
    ['Schmidt', ['XMT', 'SMT']],
    ['Thompson', ['TMSN', 'TMSN']],
    ['Müller', ['MLR', 'MLR']],
    ['', ['', '']],
  ])('%j', (input, keys) => {
    expect(doubleMetaphone(input)).toEqual(keys);
  });

  it('gives Smith and Schmidt a shared key', () => {
    const a = new Set(doubleMetaphone('Smith'));
    expect(doubleMetaphone('Schmidt').some((k) => a.has(k))).toBe(true);
  });
});

describe('phoneticKeys', () => {
  it('returns the unique soundex and metaphone keys for indexing', () => {
    expect(phoneticKeys('Smith')).toEqual(['S530', 'SM0', 'XMT']);
    expect(phoneticKeys('Thompson')).toEqual(['T512', 'TMSN']);
    expect(phoneticKeys('')).toEqual([]);
  });
});
