/**
 * C0 controls other than tab and newline, DEL, C1 controls, and the bidi
 * marks, embeddings, overrides, isolates and line separators that can
 * rewrite or reorder what a terminal shows.
 */
const CONTROLS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * Makes control characters visible (`\x1b`, `\u202e`) so text from an
 * untrusted file cannot send escape sequences to the terminal.
 */
export function escapeControls(text: string): string {
  return text.replace(CONTROLS, (c) => {
    const code = c.charCodeAt(0);
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}
