/**
 * Every C0 control (tab and newline included), DEL, C1 controls, the bidi
 * marks, embeddings, overrides and isolates, line and paragraph separators,
 * and invisible format characters (ZWSP, BOM): anything that can send escape
 * sequences to a terminal, reorder or hide text, or start a forged line.
 */
const CONTROLS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * Makes control characters visible (`\x1b`, `\n`, `\u202e`) so a value from
 * an untrusted file cannot drive the terminal or forge report lines. Apply it
 * to each value before building multi-line output, never to the whole text.
 */
export function escapeControls(text: string): string {
  return text.replace(CONTROLS, (c) => {
    const named = NAMED[c];
    if (named) return named;
    const code = c.charCodeAt(0);
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}
