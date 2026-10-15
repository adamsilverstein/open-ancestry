/*
 * Removing withheld people's names from the free text a privatized export
 * writes (#195, #212). Living relatives are named in notes, event types,
 * photo titles, file names and URLs on deceased people's records, in every
 * shape real trees use: short names ("Li Wu"), scripts without spaces
 * (李明的照片), typed without accents ("Zoe Muller" for Zoë Müller), glued to
 * digits or each other (zedekiah2015.jpg, ZedekiahLivingson, a handle).
 *
 * It is best effort: matching errs towards removing too much (a shared
 * surname, a common word that is also a name), but free text can still
 * identify someone in words that are not a name.
 */

/** The name parts of one withheld person's name. */
export interface WithheldName {
  given: string | null;
  surname: string | null;
  nickname: string | null;
  full_text: string | null;
}

/** `text` for prose, `file` for file names, URLs and e-mail addresses. */
export type ScrubMode = 'text' | 'file';

/** A word: letters (with combining marks) and digits. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const MARK = /\p{M}/u;
const DIGIT = /\p{N}/u;

/**
 * Where a word splits inside (offsets into `word`): before an upper-case
 * letter that follows a lower-case one (marks between them don't count), and
 * between letters and digits. One pass over the word: a lookbehind over any
 * number of marks was quadratic on a word made of thousands of them.
 */
function subWordCuts(word: string): number[] {
  const cuts: number[] = [];
  let last: 'lower' | 'upper' | 'letter' | 'digit' | undefined;
  let i = 0;
  for (const c of word) {
    if (!MARK.test(c)) {
      const kind = DIGIT.test(c)
        ? 'digit'
        : LOWER.test(c)
          ? 'lower'
          : UPPER.test(c)
            ? 'upper'
            : 'letter';
      const letter = kind !== 'digit';
      if (
        last !== undefined &&
        ((kind === 'upper' && last === 'lower') || letter !== (last !== 'digit'))
      ) {
        cuts.push(i);
      }
      last = kind;
    }
    i += c.length;
  }
  return cuts;
}
/** Scripts written without spaces between words, where names are matched inside longer text. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/** A run of text between spaces (and `<`, `>`, `"`), which may be a link or address. */
const CHUNK = /[^\s<>"]+/g;
const SCHEME = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;
const DOMAIN = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;
const MAIL = /@[\p{L}\p{N}-]+\./u;

/**
 * Whether a chunk of prose is a link or e-mail address: a scheme or `www.`,
 * `name@domain`, a domain followed by a path, or a bare domain. Each test is anchored or
 * scans the chunk once, so a long note stays linear (no backtracking over
 * the whole text, as a single unanchored pattern did).
 */
function isLink(chunk: string): boolean {
  if (SCHEME.test(chunk) || MAIL.test(chunk)) return true;
  const slash = chunk.indexOf('/');
  if (slash > 0) return DOMAIN.test(chunk.slice(0, slash));
  // A bare domain ("zedekiahlivingson.com."), not an abbreviation ("e.g.", "J.R.R."):
  // its last label is a word of two or more letters.
  const bare = trimPunctuation(chunk);
  return DOMAIN.test(bare) && /\.\p{L}{2,}$/u.test(bare);
}

/** A chunk without the brackets and punctuation of the sentence around it (no regex: linear). */
function trimPunctuation(chunk: string): string {
  let start = 0;
  let end = chunk.length;
  while (start < end && '(['.includes(chunk[start]!)) start++;
  while (end > start && '.,;:!?)]'.includes(chunk[end - 1]!)) end--;
  return chunk.slice(start, end);
}

/** How many layers of percent-encoding are undone (`%255A` is `%5A` is `Z`). */
const MAX_DECODE_LAYERS = 4;

/** Words shorter than this are too common on their own ("al", "li", "le"). */
const MIN_WORD = 3;
/** File names and URLs also match names of at least this many letters inside longer words. */
const MIN_SUBSTRING = 4;

/** Lower-case, without accents: "Zoë" and "ZOE" both give "zoe". */
const fold = (text: string) =>
  text
    // Compatibility forms read the same: fullwidth Ｚ, the ﬀ ligature, superscripts.
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ı/g, 'i')
    .normalize('NFC');

/** `text` folded, with the index in `text` that each folded character came from. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let i = 0;
  for (const char of text) {
    const f = fold(char);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += char.length;
  }
  map.push(text.length);
  return { folded, map };
}

/** Words of `text` with their offsets, split again inside at case and digit boundaries. */
function tokens(text: string): { start: number; end: number; parts: [number, number][] }[] {
  return [...text.matchAll(WORD)].map((m) => {
    const start = m.index;
    const word = m[0];
    const cuts = [0, ...subWordCuts(word), word.length];
    const parts: [number, number][] = [];
    for (let k = 0; k + 1 < cuts.length; k++) {
      if (cuts[k + 1]! > cuts[k]!) parts.push([start + cuts[k]!, start + cuts[k + 1]!]);
    }
    return { start, end: start + word.length, parts };
  });
}

const words = (text: string | null) => (text ? (fold(text).match(WORD) ?? []) : []);

export class NameScrubber {
  /** Single words of 3+ letters. */
  private readonly words = new Set<string>();
  /** Given + surname phrases with a short part ("li wu"), as folded words joined by spaces. */
  private readonly phrases = new Set<string>();
  private maxPhrase = 0;
  /** Matched inside longer text: unspaced-script names, always; long words and glued phrases, in files. */
  private readonly unspaced = new Set<string>();
  private readonly fileSubstrings = new Set<string>();

  constructor(names: readonly WithheldName[]) {
    for (const name of names) {
      const parts = [name.given, name.surname, name.nickname, name.full_text];
      for (const part of parts) {
        for (const word of words(part)) {
          if (word.length >= MIN_WORD) this.words.add(word);
          if (word.length >= MIN_SUBSTRING) this.fileSubstrings.add(word);
        }
      }
      const given = words(name.given);
      const surname = words(name.surname);
      const nickname = words(name.nickname);
      if (surname.length) {
        for (const first of [given, given.slice(0, 1), nickname]) {
          if (!first.length) continue;
          for (const phrase of [
            [...first, ...surname],
            [...surname, ...first],
          ]) {
            if (phrase.every((w) => w.length >= MIN_WORD)) continue; // the words cover it
            this.phrases.add(phrase.join(' '));
            this.maxPhrase = Math.max(this.maxPhrase, phrase.length);
            const glued = phrase.join('');
            if (glued.length >= MIN_SUBSTRING) this.fileSubstrings.add(glued);
          }
        }
      }
      // 李明: surname then given and the other way round, and any part of two or more.
      const g = fold(name.given ?? '').replace(/\s+/g, '');
      const s = fold(name.surname ?? '').replace(/\s+/g, '');
      for (const form of [s + g, g + s, g, s, fold(name.nickname ?? '')]) {
        if (UNSPACED.test(form) && [...form].length >= 2) this.unspaced.add(form);
      }
    }
  }

  private readonly indexes = new Map<ScrubMode, NeedleIndex>();

  /** The names matched inside longer text in this mode, indexed for one pass over a text. */
  private needles(mode: ScrubMode): NeedleIndex {
    let index = this.indexes.get(mode);
    if (!index) {
      index = new NeedleIndex(
        mode === 'file' ? [...this.unspaced, ...this.fileSubstrings] : this.unspaced,
      );
      this.indexes.set(mode, index);
    }
    return index;
  }

  get empty(): boolean {
    return !this.words.size && !this.phrases.size && !this.unspaced.size;
  }

  /** `text` with every recognized withheld name replaced by "Private". */
  scrub(input: string, mode: ScrubMode): string {
    if (this.empty || !input) return input;
    const text = input.normalize('NFC');
    // Matched as a reader sees it: without invisible format characters (soft hyphen,
    // zero-width space or joiner) and with HTML entities decoded (Zo&euml;). Matches
    // map back to the original, which is what gets replaced.
    const view = readableLayer(text);
    const seen = view?.decoded ?? text;
    const back = ([a, b]: [number, number]): [number, number] =>
      view ? [view.starts[a]!, view.starts[b]!] : [a, b];
    const ranges = mode === 'file' ? this.encodedRanges(seen) : this.ranges(seen, 'text');
    if (mode === 'text') {
      // Links and e-mail addresses inside prose follow the file-name rules.
      for (const m of seen.matchAll(CHUNK)) {
        if (!isLink(m[0])) continue;
        for (const [a, b] of this.encodedRanges(m[0])) ranges.push([m.index + a, m.index + b]);
      }
    }
    return ranges.length ? replace(text, ranges.map(back)) : text === input ? input : text;
  }

  /**
   * Matches in a file name or link, which may be percent-encoded (`%20Livingson`):
   * found in the decoded text and mapped back, so only the name's own bytes are
   * replaced and the rest (`%26`, `%2F`) stays exactly as it was.
   */
  private encodedRanges(text: string, depth = 0): [number, number][] {
    const layer = depth < MAX_DECODE_LAYERS ? decodeLayer(text) : undefined;
    if (!layer) return this.ranges(text, 'file');
    // Names may hide under several layers (%255A): decode again before matching.
    return this.encodedRanges(layer.decoded, depth + 1).map(([a, b]) => [
      layer.starts[a]!,
      layer.starts[b]!,
    ]);
  }

  /** Where withheld names occur in `text` (already NFC). */
  private ranges(text: string, mode: ScrubMode): [number, number][] {
    const ranges: [number, number][] = [];
    const list = tokens(text);
    // Whole words and the pieces of glued words.
    for (const t of list) {
      if (this.words.has(fold(text.slice(t.start, t.end)))) ranges.push([t.start, t.end]);
      else if (t.parts.length > 1) {
        for (const [a, b] of t.parts)
          if (this.words.has(fold(text.slice(a, b)))) ranges.push([a, b]);
      }
    }
    // Short names as whole phrases.
    if (this.phrases.size) {
      for (let i = 0; i < list.length; i++) {
        for (let n = 2; n <= this.maxPhrase && i + n <= list.length; n++) {
          const run = list.slice(i, i + n);
          const phrase = run.map((t) => fold(text.slice(t.start, t.end))).join(' ');
          if (this.phrases.has(phrase)) ranges.push([run[0]!.start, run[n - 1]!.end]);
        }
      }
    }
    // Names inside longer text: unspaced scripts always, long names in file names and URLs.
    const inside = this.needles(mode);
    if (inside.size) {
      const { folded, map } = foldWithMap(text);
      for (const [at, length] of inside.find(folded)) {
        ranges.push([map[at]!, map[at + length]!]);
      }
    }
    return ranges;
  }
}

/** Replaces each range with "Private"; overlapping ranges become one. */
function replace(text: string, ranges: [number, number][]): string {
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let at = 0;
  let open: [number, number] | undefined;
  for (const range of ranges) {
    if (open && range[0] < open[1]) {
      open[1] = Math.max(open[1], range[1]);
      continue;
    }
    if (open) {
      out += text.slice(at, open[0]) + 'Private';
      at = open[1];
    }
    open = [...range];
  }
  return out + text.slice(at, open![0]) + 'Private' + text.slice(open![1]);
}

/** A run of %XX escapes starting at `lastIndex` (sticky, so no scanning ahead). */
const ENCODED_RUN = /(?:%[0-9A-Fa-f]{2})+/y;

/**
 * One layer of percent-decoding, with the index in `text` where each decoded
 * UTF-16 unit starts (and `text.length` at the end); undefined when nothing
 * decodes. Runs that are not valid UTF-8 are left as they are.
 */
function decodeLayer(text: string): { decoded: string; starts: number[] } | undefined {
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return undefined;
  let decoded = '';
  const starts: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < text.length;) {
    ENCODED_RUN.lastIndex = i;
    const run = ENCODED_RUN.exec(text)?.[0];
    let chars: string | undefined;
    if (run) {
      try {
        chars = decodeURIComponent(run);
      } catch {
        chars = undefined;
      }
    }
    if (run && chars !== undefined) {
      // Each decoded character stands for its own bytes of the run.
      let at = i;
      for (const c of chars) {
        for (let u = 0; u < c.length; u++) starts.push(at);
        decoded += c;
        at += encoder.encode(c).length * 3;
      }
      i += run.length;
    } else {
      starts.push(i);
      decoded += text[i];
      i++;
    }
  }
  starts.push(text.length);
  return decoded === text ? undefined : { decoded, starts };
}

/**
 * Names matched inside longer text, found in one pass: each needle is filed
 * under its first `key` characters (the shortest needle's length), so a text
 * position costs one map lookup however many withheld people there are.
 */
class NeedleIndex {
  readonly size: number;
  private readonly key: number;
  private readonly byPrefix = new Map<string, string[]>();

  constructor(needles: Iterable<string>) {
    const list = [...new Set(needles)].filter((n) => n.length > 0);
    this.size = list.length;
    this.key = list.length ? Math.min(...list.map((n) => n.length)) : 0;
    for (const needle of list) {
      const prefix = needle.slice(0, this.key);
      const bucket = this.byPrefix.get(prefix);
      if (bucket) bucket.push(needle);
      else this.byPrefix.set(prefix, [needle]);
    }
  }

  /** Every occurrence in `text`, as [offset, length]. */
  find(text: string): [number, number][] {
    const found: [number, number][] = [];
    if (!this.size) return found;
    for (let at = 0; at + this.key <= text.length; at++) {
      const bucket = this.byPrefix.get(text.slice(at, at + this.key));
      if (!bucket) continue;
      for (const needle of bucket) {
        if (text.startsWith(needle, at)) found.push([at, needle.length]);
      }
    }
    return found;
  }
}

/** Format characters a reader never sees: soft hyphen, zero-width space and joiners. */
const INVISIBLE = /\p{Cf}/u;
/** An HTML character reference starting at `lastIndex`. */
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/y;

/** Named references for Latin letters (HTML's Latin-1 set and a few more) and markup. */
const NAMED_ENTITIES: Record<string, string> = (() => {
  const latin1 =
    'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(
      ' ',
    );
  const table: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    shy: '\u00ad',
    OElig: 'Œ',
    oelig: 'œ',
    Scaron: 'Š',
    scaron: 'š',
    Yuml: 'Ÿ',
  };
  latin1.forEach((name, i) => (table[name] = String.fromCodePoint(0xc0 + i)));
  return table;
})();

/**
 * `text` as a reader sees it, with the index in `text` where each of its
 * UTF-16 units came from (and `text.length` at the end): format characters
 * dropped and HTML character references decoded. Undefined when it is the same.
 */
function readableLayer(text: string): { decoded: string; starts: number[] } | undefined {
  if (!/&|\p{Cf}/u.test(text)) return undefined;
  let decoded = '';
  const starts: number[] = [];
  for (let i = 0; i < text.length;) {
    const c = String.fromCodePoint(text.codePointAt(i)!);
    if (INVISIBLE.test(c)) {
      i += c.length;
      continue;
    }
    if (c === '&') {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(text);
      const point = m?.[1] ? Number(m[1]) : m?.[2] ? parseInt(m[2], 16) : undefined;
      const value =
        point !== undefined
          ? point > 0 && point <= 0x10ffff
            ? String.fromCodePoint(point)
            : undefined
          : m?.[3]
            ? NAMED_ENTITIES[m[3]]
            : undefined;
      if (m && value !== undefined) {
        if (!INVISIBLE.test(value)) {
          for (let u = 0; u < value.length; u++) starts.push(i);
          decoded += value;
        }
        i += m[0].length;
        continue;
      }
    }
    for (let u = 0; u < c.length; u++) starts.push(i + u);
    decoded += c;
    i += c.length;
  }
  starts.push(text.length);
  return decoded === text ? undefined : { decoded, starts };
}
