/** One parsed GEDCOM line. `value` is raw: escapes are resolved by the parser. */
export interface Token {
  level: number;
  tag: string;
  xref?: string;
  value?: string;
  /** Level had a leading zero (`01`), which GEDCOM forbids. */
  levelFormat?: true;
}

const SPACE = 0x20;
const TAB = 0x09;
const AT = 0x40;
const ZERO = 0x30;
const NINE = 0x39;

const isDelimiter = (c: number) => c === SPACE || c === TAB;

function isTagChar(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) || // A-Z
    (c >= 0x61 && c <= 0x7a) || // a-z
    (c >= ZERO && c <= NINE) ||
    c === 0x5f // _
  );
}

/**
 * Tokenizes one line (without its terminator) or returns undefined when it is
 * not a GEDCOM line. Lenient where real files are: leading whitespace, tabs or
 * repeated delimiters before the tag, any line length. Strict where leniency
 * would swallow note text: levels are 0-99, tags are `[A-Za-z0-9_]+`, and a
 * tag with lowercase letters must start with `_` (so "1 name x" is text).
 * Everything after the single delimiter following the tag is the value.
 */
export function tokenizeLine(line: string): Token | undefined {
  const n = line.length;
  let i = 0;
  while (i < n && isDelimiter(line.charCodeAt(i))) i++;

  const levelStart = i;
  while (i < n && line.charCodeAt(i) >= ZERO && line.charCodeAt(i) <= NINE) i++;
  const digits = i - levelStart;
  if (digits === 0 || digits > 2 || i === n || !isDelimiter(line.charCodeAt(i))) return undefined;
  const level =
    digits === 1
      ? line.charCodeAt(levelStart) - ZERO
      : (line.charCodeAt(levelStart) - ZERO) * 10 + line.charCodeAt(levelStart + 1) - ZERO;
  while (i < n && isDelimiter(line.charCodeAt(i))) i++;

  let xref: string | undefined;
  if (line.charCodeAt(i) === AT) {
    const close = line.indexOf('@', i + 1);
    if (close === -1 || close === i + 1) return undefined;
    xref = line.slice(i, close + 1);
    if (xref.includes(' ')) return undefined;
    i = close + 1;
    if (i === n || !isDelimiter(line.charCodeAt(i))) return undefined;
    while (i < n && isDelimiter(line.charCodeAt(i))) i++;
  }

  const tagStart = i;
  let lower = false;
  for (; i < n; i++) {
    const c = line.charCodeAt(i);
    if (!isTagChar(c)) break;
    if (c >= 0x61) lower = true;
  }
  if (i === tagStart) return undefined;
  if (i < n && !isDelimiter(line.charCodeAt(i))) return undefined;
  const tag = line.slice(tagStart, i);
  if (lower && tag.charCodeAt(0) !== 0x5f) return undefined;

  const token: Token = { level, tag };
  if (xref !== undefined) token.xref = xref;
  if (i < n) token.value = line.slice(i + 1);
  if (digits === 2 && line.charCodeAt(levelStart) === ZERO) token.levelFormat = true;
  return token;
}

/**
 * Splits streamed text into lines on CRLF, LF or CR. A CR at the end of a
 * chunk is held back until the next chunk shows whether an LF follows.
 */
export class LineSplitter {
  /**
   * Pieces of the unfinished last line. Each chunk is scanned once and only
   * joined when its line ends, so a huge line split over many chunks stays linear.
   */
  private partial: string[] = [];
  private pendingCR = false;

  private readonly onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  private emit(chunk: string, from: number, to: number) {
    const piece = chunk.slice(from, to);
    if (this.partial.length === 0) {
      this.onLine(piece);
      return;
    }
    this.partial.push(piece);
    const line = this.partial.join('');
    this.partial = [];
    this.onLine(line);
  }

  push(chunk: string): void {
    const n = chunk.length;
    let lineStart = 0;
    if (this.pendingCR) {
      this.pendingCR = false;
      if (chunk.charCodeAt(0) === 0x0a) lineStart = 1;
    }
    for (let i = lineStart; i < n; i++) {
      const c = chunk.charCodeAt(i);
      if (c === 0x0a) {
        this.emit(chunk, lineStart, i);
        lineStart = i + 1;
      } else if (c === 0x0d) {
        this.emit(chunk, lineStart, i);
        if (i + 1 === n) {
          this.pendingCR = true;
        } else if (chunk.charCodeAt(i + 1) === 0x0a) {
          i++;
        }
        lineStart = i + 1;
      }
    }
    if (lineStart < n) this.partial.push(chunk.slice(lineStart));
  }

  end(): void {
    if (this.partial.length) this.onLine(this.partial.join(''));
    this.partial = [];
    this.pendingCR = false;
  }
}

export function splitLines(text: string): string[] {
  const lines: string[] = [];
  const splitter = new LineSplitter((line) => lines.push(line));
  splitter.push(text);
  splitter.end();
  return lines;
}
