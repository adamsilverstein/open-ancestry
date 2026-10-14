/** Removes a leading UTF-8 byte order mark, which Ancestry exports include. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
