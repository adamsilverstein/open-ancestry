/*
 * Text that renders as something else (#190): control characters and bidi
 * controls in a name can reorder the text after it ("Evil" + U+202E makes the
 * surname read backwards), and tabs or newlines break GEDCOM NAME lines.
 * Writes refuse them (`unsafeTextReason`); what is already stored, such as an
 * imported file, is cleaned for display (`displayText`).
 */

/**
 * C0 controls (tab and newline included), DEL, C1 controls, the line and
 * paragraph separators (U+2028, U+2029: line breaks, and U+2029 ends every
 * embedding) and the obsolete format controls U+206A-U+206F.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u206a-\u206f]/u;
// eslint-disable-next-line no-control-regex -- as above
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u206a-\u206f]/gu;
/** LRE, RLE, PDF, LRO, RLO: embeddings and overrides, which leak past the text they are in. */
const EMBEDDING = /[‪-‮]/u;
const EMBEDDINGS = /[‪-‮]/gu;
/** LRI, RLI, FSI open an isolate; PDI closes one. Balanced isolates are harmless. */
const ISOLATES = /[⁦-⁩]/gu;
/**
 * Zero-width space, word joiner, BOM and the direction marks (ALM, LRM, RLM):
 * harmless in a name, but two names that differ only by one look the same.
 * ZWJ and ZWNJ are left out: emoji sequences and Persian need them.
 */
const INVISIBLE = /[\u061c\u200b\u200e\u200f\u2060\ufeff]/u;
const INVISIBLES = /[\u061c\u200b\u200e\u200f\u2060\ufeff]/gu;

/** A character as `U+XXXX`, for messages about characters people cannot see. */
export const hex = (char: string) =>
  `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

function isolatesBalanced(text: string): boolean {
  let depth = 0;
  for (const [char] of text.matchAll(ISOLATES)) {
    depth += char === '⁩' ? -1 : 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Why `text` cannot be stored as a name, place or date, or null when it can. */
export function unsafeTextReason(text: string): string | null {
  const control = CONTROL.exec(text);
  if (control)
    return `contains a control character (${hex(control[0])}), such as a tab or line break`;
  const embedding = EMBEDDING.exec(text);
  if (embedding) {
    return `contains ${hex(embedding[0])}, an invisible character that overrides text direction`;
  }
  if (!isolatesBalanced(text)) return 'has a text direction isolate that is not closed';
  return null;
}

/**
 * Stored text made safe to show: control characters become spaces, and
 * embeddings, overrides and unbalanced isolates are dropped.
 */
export function displayText(text: string): string {
  if (!CONTROL.test(text) && !EMBEDDING.test(text) && isolatesBalanced(text)) return text;
  const cleaned = text.replace(CONTROLS, ' ').replace(EMBEDDINGS, '');
  return (isolatesBalanced(cleaned) ? cleaned : cleaned.replace(ISOLATES, ''))
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Stored text for a sentence such as "Merge X into Y?": cleaned, and wrapped
 * in a first-strong isolate (U+2068...U+2069) so a right-to-left name cannot
 * reorder the words around it (#264). Components that show such strings turn
 * the isolates into `<bdi>`.
 */
export function isolate(text: string): string {
  const shown = displayText(text);
  return shown ? `⁨${shown}⁩` : '';
}

/** The first invisible character in `text` (see `INVISIBLE`), or null. */
export function invisibleChar(text: string): string | null {
  return INVISIBLE.exec(text)?.[0] ?? null;
}

/** `text` without invisible characters (see `INVISIBLE`). */
export const stripInvisible = (text: string): string => text.replace(INVISIBLES, '');

/** `text` without bidi isolates, for plain text such as a toast's screen reader alternative. */
export const stripIsolates = (text: string): string => text.replace(ISOLATES, '');
