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
/** Inside a word: before an upper-case letter after a lower-case one, and between letters and digits. */
const SUB_WORD = /(?<=\p{Ll}\p{M}*)(?=\p{Lu})|(?<=[\p{L}\p{M}])(?=\p{N})|(?<=\p{N})(?=\p{L})/gu;
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
 * `name@domain`, or a domain followed by a path. Each test is anchored or
 * scans the chunk once, so a long note stays linear (no backtracking over
 * the whole text, as a single unanchored pattern did).
 */
function isLink(chunk: string): boolean {
  if (SCHEME.test(chunk) || MAIL.test(chunk)) return true;
  const slash = chunk.indexOf('/');
  return slash > 0 && DOMAIN.test(chunk.slice(0, slash));
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
    const cuts = [0, ...[...word.matchAll(SUB_WORD)].map((c) => c.index), word.length];
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

  get empty(): boolean {
    return !this.words.size && !this.phrases.size && !this.unspaced.size;
  }

  /** `text` with every recognized withheld name replaced by "Private". */
  scrub(input: string, mode: ScrubMode): string {
    if (this.empty || !input) return input;
    const text = input.normalize('NFC');
    const ranges = mode === 'file' ? this.encodedRanges(text) : this.ranges(text, 'text');
    if (mode === 'text') {
      // Links and e-mail addresses inside prose follow the file-name rules.
      for (const m of text.matchAll(CHUNK)) {
        if (!isLink(m[0])) continue;
        for (const [a, b] of this.encodedRanges(m[0])) ranges.push([m.index + a, m.index + b]);
      }
    }
    return ranges.length ? replace(text, ranges) : text === input ? input : text;
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
    const inside =
      mode === 'file' ? [...this.unspaced, ...this.fileSubstrings] : [...this.unspaced];
    if (inside.length) {
      const { folded, map } = foldWithMap(text);
      for (const needle of inside) {
        for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + 1)) {
          ranges.push([map[at]!, map[at + needle.length]!]);
        }
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
