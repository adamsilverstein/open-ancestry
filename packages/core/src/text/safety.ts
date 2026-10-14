/*
 * Text that renders as something else (#190): control characters and bidi
 * controls in a name can reorder the text after it ("Evil" + U+202E makes the
 * surname read backwards), and tabs or newlines break GEDCOM NAME lines.
 * Writes refuse them (`unsafeTextReason`); what is already stored, such as an
 * imported file, is cleaned for display (`displayText`).
 */

/** C0 controls (tab and newline included), DEL and C1 controls. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;
/** LRE, RLE, PDF, LRO, RLO: embeddings and overrides, which leak past the text they are in. */
const EMBEDDING = /[‪-‮]/u;
const EMBEDDINGS = /[‪-‮]/gu;
/** LRI, RLI, FSI open an isolate; PDI closes one. Balanced isolates are harmless. */
const ISOLATES = /[⁦-⁩]/gu;

const hex = (char: string) =>
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
