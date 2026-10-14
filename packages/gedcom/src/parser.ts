import {
  DETECT_BYTES,
  bomLength,
  createDecoder,
  decodeGedcom,
  detectEncoding,
  asciiFallbackWarning,
  decodeFailedWarning,
  invalidBytesWarning,
  isValidUtf8,
  mismatchWarnings,
} from './encoding';
import { analyzeHeader } from './header';
import { LineSplitter, XREF_PATTERN, looksStructural, parseLine, type Token } from './tokenizer';
import type {
  Continuation,
  EncodingInfo,
  GedcomNode,
  GedcomWarning,
  LineAccounting,
  ParseOptions,
  ParseResult,
  SkippedLine,
  WarningCode,
} from './types';

/** Characters an edited value cannot keep verbatim (see `serializeNode`). */
// eslint-disable-next-line no-control-regex
const REENCODED = /[\x00-\x08\x0b-\x1f\u0085\u2028\u2029]/;

/** Whether a raw value is a pointer such as `@I1@` or `@VOID@` (not `@@` or `@#D`). */
export function isPointer(raw: string): boolean {
  return raw.charCodeAt(0) === 0x40 && raw.charCodeAt(1) !== 0x23 && XREF_PATTERN.test(raw);
}

/**
 * Resolves `@@` escapes. GEDCOM 5.5.1 doubles every `@` in text; GEDCOM 7
 * only escapes a leading `@`. A lone `@` (common in 5.5.1 email addresses) is kept.
 */
export function decodeEscapes(raw: string, major: number): string {
  if (!raw.includes('@@')) return raw;
  if (major >= 7) return raw.startsWith('@@') ? raw.slice(1) : raw;
  return raw.replaceAll('@@', '@');
}

/** Rebuilds a node's value from its head-line raw value and continuations. */
export function composeValue(
  raw: string | undefined,
  continuations: readonly Continuation[] | undefined,
  major: number,
): string | undefined {
  let value = raw === undefined ? undefined : decodeEscapes(raw, major);
  if (!continuations) return value;
  value ??= '';
  for (const c of continuations) {
    const text = c.broken ? c.value : decodeEscapes(c.value, major);
    value += c.tag === 'CONT' ? '\n' + text : text;
  }
  return value;
}

/** Every source line a node and its descendants came from, in source order. */
export function subtreeLines(node: GedcomNode): number[] {
  const out: number[] = [];
  const visit = (n: GedcomNode) => {
    out.push(n.line);
    if (n.extra) for (const e of n.extra) out.push(e.line);
    for (const c of n.continuations ?? []) {
      out.push(c.line);
      if (c.extra) for (const e of c.extra) out.push(e.line);
    }
    for (const child of n.children) visit(child);
  };
  visit(node);
  return out.sort((a, b) => a - b);
}

/** Incremental tree builder: feed it lines in order, then call `finish`. */
class TreeBuilder {
  readonly records: GedcomNode[] = [];
  readonly index = new Map<string, GedcomNode>();
  readonly warnings: GedcomWarning[] = [];
  readonly skipped: SkippedLine[] = [];
  readonly preamble: SkippedLine[] = [];
  warningCount = 0;
  readonly lines: LineAccounting = {
    total: 0,
    nodes: 0,
    continuations: 0,
    blank: 0,
    skipped: 0,
    detached: 0,
  };

  /** Open nodes from the current record down to the last node. */
  private stack: GedcomNode[] = [];
  /** Last node created; bare text lines continue its value. */
  private last: GedcomNode | undefined;
  /** Last node or continuation line; blank and unparseable lines that follow attach to it. */
  private lastUnit: GedcomNode | Continuation | undefined;
  /** Raw head-line values of nodes with continuations, needed to recompose `value`. */
  private heads = new Map<GedcomNode, string | undefined>();
  private pendingBlanks: SkippedLine[] = [];
  private major = 5;
  private sawHead = false;
  private sawTrlr = false;
  /** Whether the decoder has replaced invalid bytes, so U+FFFD in a line is worth flagging. */
  hasInvalidBytes = () => false;

  private readonly maxWarnings: number;

  constructor(maxWarnings: number) {
    this.maxWarnings = maxWarnings;
  }

  warn(code: WarningCode, line: number, message: string): void {
    this.warningCount++;
    if (this.warnings.length < this.maxWarnings) this.warnings.push({ code, line, message });
  }

  addLine(text: string): void {
    const lineNo = ++this.lines.total;
    if (text.includes('\uFFFD') && this.hasInvalidBytes()) {
      this.warn('replacement-char', lineNo, 'Line contains bytes that could not be decoded');
    }
    if (isBlank(text)) {
      this.pendingBlanks.push({ line: lineNo, text });
      return;
    }
    const token = parseLine(text);
    if (token) {
      this.flushBlanks();
      if (token.repaired) {
        this.warn('malformed-line', lineNo, 'Repaired a malformed line; check this record');
      }
      this.addToken(token, lineNo, text);
      return;
    }
    if (looksStructural(text)) {
      this.flushBlanks();
      this.skip(text, lineNo, 'Malformed GEDCOM line skipped');
      // A broken level-0 line starts a new record; never let its lines join the previous one.
      if (/^[ \t]*0+[ \t]/.test(text)) {
        this.stack = [];
        this.last = undefined;
      }
      return;
    }
    if (this.last && this.last.pointer === undefined) {
      for (const blank of this.pendingBlanks) this.addBroken(blank.text, blank.line);
      this.pendingBlanks = [];
      this.addBroken(text, lineNo);
      return;
    }
    this.flushBlanks();
    this.skip(text, lineNo, 'Line is not valid GEDCOM and has no text value to continue');
  }

  private skip(text: string, lineNo: number, message: string) {
    const entry = { line: lineNo, text };
    this.lines.skipped++;
    this.skipped.push(entry);
    this.attach(entry);
    this.warn('skipped-line', lineNo, message);
  }

  /** Keeps a blank or skipped line next to the line it followed, so records re-emit exactly. */
  private attach(entry: SkippedLine) {
    if (this.lastUnit) {
      (this.lastUnit.extra ??= []).push(entry);
    } else {
      this.preamble.push(entry);
      this.lines.detached++;
    }
  }

  private flushBlanks() {
    this.lines.blank += this.pendingBlanks.length;
    for (const blank of this.pendingBlanks) this.attach(blank);
    this.pendingBlanks = [];
  }

  /** Ancestry writes multi-line text as bare lines; treat each as CONT (python-gedcom does the same). */
  private addBroken(text: string, lineNo: number) {
    const owner = this.last!;
    this.addContinuation(owner, {
      tag: 'CONT',
      level: owner.level + 1,
      line: lineNo,
      value: text,
      broken: true,
    });
    this.warn(
      'broken-line',
      lineNo,
      `Line has no level or tag; treated as CONT of line ${owner.line}`,
    );
  }

  private addContinuation(owner: GedcomNode, c: Continuation) {
    this.lines.continuations++;
    this.lastUnit = c;
    if (!owner.continuations) {
      owner.continuations = [];
      this.heads.set(owner, owner.rawValue ?? owner.value);
    }
    owner.continuations.push(c);
  }

  private addToken(token: Token, lineNo: number, text: string) {
    const { level, tag } = token;
    if (token.levelFormat) this.warn('level-format', lineNo, 'Level has a leading zero');

    while (this.stack.length && this.stack[this.stack.length - 1]!.level >= level) this.stack.pop();
    const parent = this.stack[this.stack.length - 1];

    if ((tag === 'CONC' || tag === 'CONT') && token.xref === undefined) {
      const owner = parent && level === parent.level + 1 ? parent : undefined;
      if (owner && owner.children.length === 0) {
        const c: Continuation = { tag, level, line: lineNo, value: token.value ?? '' };
        // Canonical output writes an empty continuation without a trailing space.
        if (token.nonCanonical || token.value === '') c.source = text;
        this.addContinuation(owner, c);
        return;
      }
      this.warn(
        'misplaced-continuation',
        lineNo,
        `${tag} does not directly follow a value; kept as a child`,
      );
    }

    this.lines.nodes++;
    const node: GedcomNode = { level, tag, children: [], line: lineNo };
    if (token.xref !== undefined) node.xref = token.xref;
    if (token.nonCanonical) node.source = text;
    const raw = token.value;
    if (raw !== undefined) {
      if (isPointer(raw)) {
        node.pointer = raw;
      } else {
        const value = decodeEscapes(raw, this.major);
        node.value = value;
        // Kept whenever re-encoding `value` would not give back the same text: `@`
        // escaping, and characters the serializer turns into CONT or drops.
        if (raw.includes('@') || REENCODED.test(raw)) node.rawValue = raw;
      }
    }

    if (parent) {
      if (level > parent.level + 1) {
        this.warn(
          'level-jump',
          lineNo,
          `Level ${level} under level ${parent.level} (line ${parent.line})`,
        );
      }
      parent.children.push(node);
      if (tag === 'VERS' && parent.tag === 'GEDC' && this.stack[0]?.tag === 'HEAD') {
        const major = parseInt(node.value ?? '', 10);
        if (major > 0) this.major = major;
      }
    } else {
      this.addRecord(node, lineNo);
    }
    this.stack.push(node);
    this.last = node;
    this.lastUnit = node;
  }

  private addRecord(node: GedcomNode, lineNo: number) {
    if (node.level !== 0) {
      this.warn(
        'orphan-line',
        lineNo,
        `Level ${node.level} line has no parent record; kept as a record`,
      );
    }
    if (this.sawTrlr) this.warn('after-trlr', lineNo, 'Record after TRLR');
    if (node.tag === 'HEAD') this.sawHead = true;
    if (node.tag === 'TRLR') this.sawTrlr = true;
    if (node.xref !== undefined) {
      const existing = this.index.get(node.xref);
      if (existing) {
        this.warn(
          'duplicate-xref',
          lineNo,
          `${node.xref} already defined on line ${existing.line}`,
        );
      } else {
        this.index.set(node.xref, node);
      }
    }
    this.records.push(node);
  }

  finish(): void {
    this.flushBlanks();
    for (const [node, raw] of this.heads) {
      // Pointer nodes keep `pointer`; their continuations still become `value`.
      node.value = composeValue(node.pointer ? undefined : raw, node.continuations, this.major);
      if (raw !== undefined && !node.pointer) node.rawValue = raw;
    }
    if (!this.sawHead) this.warn('missing-head', 0, 'File does not start with a HEAD record');
    if (!this.sawTrlr) this.warn('missing-trlr', 0, 'File has no TRLR record; it may be truncated');
  }
}

function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09) return false;
  }
  return true;
}

function result(
  builder: TreeBuilder,
  encoding: EncodingInfo,
  encodingWarnings: GedcomWarning[],
): ParseResult {
  builder.finish();
  const head = builder.records.find((r) => r.tag === 'HEAD');
  return {
    encoding,
    header: analyzeHeader(head),
    records: builder.records,
    index: builder.index,
    warnings: [...encodingWarnings, ...builder.warnings],
    warningCount: builder.warningCount + encodingWarnings.length,
    lineCount: builder.lines.total,
    lines: builder.lines,
    skipped: builder.skipped,
    preamble: builder.preamble,
  };
}

const DEFAULT_MAX_WARNINGS = 1000;

/**
 * Parses a GEDCOM 5.5.1 or 7 file into a record tree. Never throws: problems
 * become warnings with line numbers.
 */
export function parseGedcom(input: Uint8Array | string, options: ParseOptions = {}): ParseResult {
  const builder = new TreeBuilder(options.maxWarnings ?? DEFAULT_MAX_WARNINGS);
  let text: string;
  let encoding: EncodingInfo;
  let encodingWarnings: GedcomWarning[] = [];
  if (typeof input === 'string') {
    text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    encoding = { encoding: 'utf-8', source: 'option', bom: text !== input };
  } else {
    ({ text, encoding, warnings: encodingWarnings } = decodeGedcom(input, options));
    const invalid = encodingWarnings.some((w) => w.code === 'invalid-bytes');
    builder.hasInvalidBytes = () => invalid;
  }
  const splitter = new LineSplitter((line) => builder.addLine(line));
  splitter.push(text);
  splitter.end();
  return result(builder, encoding, encodingWarnings);
}

/**
 * Parses a byte stream (a Node or web ReadableStream, or any async iterable of
 * chunks) without holding the whole file as one string. The encoding is
 * detected from the first 64 KiB.
 */
export async function parseGedcomStream(
  source: AsyncIterable<Uint8Array>,
  options: ParseOptions = {},
): Promise<ParseResult> {
  const builder = new TreeBuilder(options.maxWarnings ?? DEFAULT_MAX_WARNINGS);
  const splitter = new LineSplitter((line) => builder.addLine(line));
  const head: Uint8Array[] = [];
  let headSize = 0;
  let decoder: ReturnType<typeof createDecoder> | undefined;
  let encoding: EncodingInfo | undefined;
  let fallback = false;

  const start = (complete: boolean) => {
    const prefix = concatBytes(head, headSize);
    encoding = detectEncoding(prefix, { encoding: options.encoding, complete });
    if (encoding.encoding === 'ascii' && !isValidUtf8(prefix, !complete)) {
      encoding = { ...encoding, encoding: 'windows-1252' };
      fallback = true;
    }
    const active = createDecoder(encoding.encoding);
    decoder = active;
    // Each chunk is decoded before its lines are split, so this is current for every line.
    builder.hasInvalidBytes = () => active.invalidBytes() > 0;
    splitter.push(decoder.decode(prefix.subarray(bomLength(prefix, encoding.encoding))));
  };

  let failure: GedcomWarning | undefined;
  try {
    for await (const chunk of source) {
      if (decoder) {
        splitter.push(decoder.decode(chunk));
        continue;
      }
      head.push(chunk);
      headSize += chunk.length;
      if (headSize >= DETECT_BYTES) start(false);
    }
    if (!decoder) start(true);
    splitter.push(decoder!.end());
    splitter.end();
  } catch (error) {
    // A single line over V8's maximum string length; keep what was parsed.
    if (!(error instanceof RangeError)) throw error;
    failure = decodeFailedWarning(error);
  }

  const warnings = mismatchWarnings(encoding!);
  if (failure) warnings.push(failure);
  if (fallback) warnings.push(asciiFallbackWarning());
  const invalid = decoder!.invalidBytes();
  if (invalid > 0) warnings.push(invalidBytesWarning(invalid, encoding!.encoding));
  return result(builder, encoding!, warnings);
}

function concatBytes(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
