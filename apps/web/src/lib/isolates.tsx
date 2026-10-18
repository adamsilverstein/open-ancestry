import type { ReactNode } from 'react';

const FSI = '⁨';
const PDI = '⁩';
const OPENS = new Set(['⁦', '⁧', FSI]);

/**
 * A string built with `isolate` (core), shown with each isolated name as a
 * `<bdi>` instead of the invisible U+2068...U+2069 pair (#264): the name still
 * cannot reorder the words around it, and the text people and assistive tech
 * get has no stray marks. Isolates inside a name stay as they are.
 */
export function withIsolates(text: string): ReactNode {
  if (!text.includes(FSI)) return text;
  const parts: ReactNode[] = [];
  let plain = '';
  let inner = '';
  let depth = 0;
  for (const char of text) {
    if (depth === 0) {
      if (char === FSI) {
        depth = 1;
        if (plain) parts.push(plain);
        plain = '';
      } else plain += char;
      continue;
    }
    if (OPENS.has(char)) depth++;
    else if (char === PDI) depth--;
    if (depth > 0) inner += char;
    else {
      parts.push(<bdi key={parts.length}>{inner}</bdi>);
      inner = '';
    }
  }
  // An isolate left open runs to the end, as it would in the string.
  if (depth > 0) parts.push(<bdi key={parts.length}>{inner}</bdi>);
  if (plain) parts.push(plain);
  return parts;
}

/** `withIsolates` for a slot that may hold a string or elements. */
export const shownText = (node: ReactNode): ReactNode =>
  typeof node === 'string' ? withIsolates(node) : node;
