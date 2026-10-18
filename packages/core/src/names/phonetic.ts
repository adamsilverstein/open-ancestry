import { doubleMetaphone as metaphone } from './double-metaphone';

// Letters NFD does not decompose into a base letter plus a mark.
const SPECIAL: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
};

/** Hebrew points and cantillation, and Arabic harakat: written in some records, left out in others. */
const VOWEL_MARKS = /[\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u064b-\u065f\u0670]/gu;

/**
 * The spelling fold shared by the search index and the query (#199): ı and i,
 * ß and ss, pointed and unpointed Hebrew, Arabic with and without harakat, and
 * O'Brien and OBrien read the same. Invisible format characters (zero-width
 * space and joiner, soft hyphen, bidi controls) go too, so they cannot split a
 * word (#190). Case and Latin diacritics are left to the FTS tokenizer.
 */
export function foldForSearch(text: string): string {
  return (
    text
      .normalize('NFC')
      .replace(/\p{Cf}/gu, '')
      .replace(VOWEL_MARKS, '')
      // Turkish: dotless ı and dotted İ (whose lower case gains a combining dot) are plain i.
      .replace(/ı/g, 'i')
      .replace(/İ/g, 'I')
      .replace(/ß/g, 'ss')
      .replace(/ẞ/g, 'SS')
      .replace(/(?<=[\p{L}\p{N}])['’ʼ](?=[\p{L}\p{N}])/gu, '')
  );
}

/** A word with an apostrophe inside it, such as O'Brien or D’Angelo. */
const APOSTROPHE_WORD = /[\p{L}\p{N}]+(?:['’ʼ][\p{L}\p{N}]+)+/gu;

/**
 * The fold for indexed text: as `foldForSearch`, but a word with an apostrophe
 * is kept both joined and split ("OBrien O Brien"), so O'Brien is found by
 * OBrien, O'Brien and Brien alike.
 */
export function foldForIndex(text: string): string {
  const expanded = text
    .normalize('NFC')
    .replace(APOSTROPHE_WORD, (word) => `${word} ${word.replace(/['’ʼ]/g, ' ')}`);
  return foldForSearch(expanded);
}

/** Lower-case, accent-free, punctuation-free text for search: `Émile O'Brien` -> `emile obrien`. */
export function normalizeForSearch(text: string): string {
  return foldForSearch(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[ßæœøłđðþı]/g, (c) => SPECIAL[c]!)
    .replace(/['’ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const lettersOnly = (text: string): string => normalizeForSearch(text).replace(/[^a-z]/g, '');

const SOUNDEX_CODES: Record<string, string> = {};
for (const [letters, code] of [
  ['AEIOUY', '0'],
  ['BFPV', '1'],
  ['CGJKQSXZ', '2'],
  ['DT', '3'],
  ['L', '4'],
  ['MN', '5'],
  ['R', '6'],
] as const) {
  for (const letter of letters) SOUNDEX_CODES[letter] = code;
}

/** American Soundex (`Robert` -> `R163`); H and W do not separate equal codes. */
export function soundex(name: string): string {
  const s = lettersOnly(name).toUpperCase();
  if (!s) return '';
  let result = s[0]!;
  let last = SOUNDEX_CODES[s[0]!] ?? '';
  for (let i = 1; i < s.length && result.length < 4; i++) {
    const letter = s[i]!;
    if (letter === 'H' || letter === 'W') continue;
    const code = SOUNDEX_CODES[letter]!;
    if (code !== '0' && code !== last) result += code;
    last = code;
  }
  return result.padEnd(4, '0');
}

/** Double Metaphone [primary, secondary] keys of the accent-folded name. */
export function doubleMetaphone(name: string): [string, string] {
  return metaphone(lettersOnly(name));
}

/** Unique phonetic keys (Soundex, then Double Metaphone) for indexing a surname. */
export function phoneticKeys(surname: string): string[] {
  return [...new Set([soundex(surname), ...doubleMetaphone(surname)])].filter(Boolean);
}
