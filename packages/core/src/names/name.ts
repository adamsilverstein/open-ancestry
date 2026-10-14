export interface PersonName {
  prefix: string;
  given: string;
  nickname: string;
  surname: string;
  suffix: string;
}

export type NameFormat = 'given-first' | 'surname-first' | 'sort';

const PREFIX =
  /^(?:DR|MR|MRS|MS|MISS|MX|REV|SIR|DAME|LADY|LORD|CAPT|COL|GEN|LT|SGT|MAJ|PROF|HON|FR)\.?$/i;
const SUFFIX = /^(?:JR|SR|I{2,3}|IV|V|VI|ESQ|PHD|MD)\.?$/i;
const NICKNAME = /["“”]([^"“”]*)["“”]/;

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Parses a GEDCOM NAME value (`Given /Surname/ Suffix`). Without slashes the
 * last word is taken as the surname, which suits hand-typed names.
 */
export function parseName(value: string): PersonName {
  let s = typeof value === 'string' ? value : '';
  let nickname = '';
  const nick = NICKNAME.exec(s);
  if (nick) {
    nickname = clean(nick[1]!);
    s = s.replace(nick[0], ' ');
  }
  s = clean(s);

  let given: string;
  let surname = '';
  let suffix = '';
  const slash = s.indexOf('/');
  if (slash >= 0) {
    given = s.slice(0, slash);
    const rest = s.slice(slash + 1);
    const close = rest.indexOf('/');
    surname = close >= 0 ? rest.slice(0, close) : rest;
    suffix = close >= 0 ? rest.slice(close + 1) : '';
  } else {
    const words = s ? s.split(' ') : [];
    if (words.length > 2 && SUFFIX.test(words.at(-1)!)) suffix = words.pop()!;
    surname = words.length > 1 ? words.pop()! : '';
    given = words.join(' ');
  }

  let prefix = '';
  const givenWords = clean(given).split(' ');
  if (givenWords.length > 1 && PREFIX.test(givenWords[0]!)) prefix = givenWords.shift()!;
  if (givenWords.length === 1 && PREFIX.test(givenWords[0]!) && surname)
    prefix = givenWords.shift()!;

  return {
    prefix,
    given: givenWords.join(' '),
    nickname,
    surname: clean(surname),
    suffix: clean(suffix),
  };
}

const asName = (name: PersonName | string): PersonName =>
  typeof name === 'string' ? parseName(name) : name;
const join = (...parts: string[]): string => parts.filter(Boolean).join(' ');

export function formatName(name: PersonName | string, format: NameFormat = 'given-first'): string {
  const n = asName(name);
  switch (format) {
    case 'surname-first':
      return join(n.surname, n.given, n.suffix);
    case 'sort': {
      const rest = join(n.given, n.suffix);
      return n.surname && rest ? `${n.surname}, ${rest}` : n.surname || rest;
    }
    default:
      return join(n.prefix, n.given, n.surname, n.suffix);
  }
}

/** `Dr. John Henry Smith Jr.` */
export const displayName = (name: PersonName | string): string => formatName(name, 'given-first');

/** `Smith, John Henry Jr.` */
export const sortName = (name: PersonName | string): string => formatName(name, 'sort');

/** First given initial plus surname initial (`JS`), or the first two given initials. */
export function initials(name: PersonName | string): string {
  const n = asName(name);
  const given = n.given.split(' ').filter(Boolean);
  const words = n.surname ? [...given.slice(0, 1), n.surname] : given.slice(0, 2);
  return words.map((w) => Array.from(w)[0]!.toUpperCase()).join('');
}
