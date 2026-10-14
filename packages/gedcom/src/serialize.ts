import { composeValue } from './parser';
import { TAG_PATTERN, XREF_PATTERN, parseLine } from './tokenizer';
import type { GedcomNode, ParseResult, SkippedLine } from './types';

export interface SerializeOptions {
  /** Line terminator (default `\n`). */
  eol?: string;
  /** GEDCOM major version, which decides `@@` escaping for edited values (default 5). */
  version?: number;
  /**
   * Split edited values longer than this many characters per line with CONC.
   * Unset means no limit. Values that were not edited keep their original lines.
   */
  maxLineLength?: number;
}

export type GedcomSerializeErrorCode =
  | 'invalid-level'
  | 'invalid-tag'
  | 'invalid-xref'
  | 'invalid-pointer'
  | 'invalid-eol'
  | 'line-break-in-source';

/** Thrown when a node cannot be written without corrupting or injecting GEDCOM lines. */
export class GedcomSerializeError extends Error {
  readonly code: GedcomSerializeErrorCode;

  constructor(code: GedcomSerializeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'GedcomSerializeError';
  }
}

/** Every character sequence some reader treats as a line break. CONT carries them instead. */
const LINE_BREAK = /\r\n|\r|\n|\u2028|\u2029|\u0085/;
/** C0 controls other than tab; they have no meaning in a value and can confuse readers. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f]/g;
const CR_OR_LF = /[\r\n]/;

/** Splits an edited value into the lines it will be written as, without control characters. */
export function valueLines(value: string): string[] {
  return value.split(new RegExp(LINE_BREAK, 'g')).map((part) => part.replace(CONTROL, ''));
}

/**
 * Rejects anything that would change the line structure of the output: the
 * level, tag, xref and pointer must match the grammar the tokenizer accepts.
 */
function validate(node: GedcomNode) {
  const where = `line ${node.line} (${JSON.stringify(node.tag)})`;
  if (!Number.isInteger(node.level) || node.level < 0 || node.level > 99) {
    throw new GedcomSerializeError('invalid-level', `Level ${node.level} at ${where} is not 0-99`);
  }
  if (!TAG_PATTERN.test(node.tag)) {
    throw new GedcomSerializeError('invalid-tag', `Invalid tag at ${where}`);
  }
  if (node.xref !== undefined && !XREF_PATTERN.test(node.xref)) {
    throw new GedcomSerializeError(
      'invalid-xref',
      `Invalid xref ${JSON.stringify(node.xref)} at ${where}`,
    );
  }
  if (
    node.pointer !== undefined &&
    (!XREF_PATTERN.test(node.pointer) || node.pointer.startsWith('@#'))
  ) {
    throw new GedcomSerializeError(
      'invalid-pointer',
      `Invalid pointer ${JSON.stringify(node.pointer)} at ${where}`,
    );
  }
}

/** Source text is split on CR and LF by the tokenizer, so a CR or LF here means a hand-built node. */
function assertSingleLine(text: string, node: GedcomNode) {
  if (CR_OR_LF.test(text)) {
    throw new GedcomSerializeError(
      'line-break-in-source',
      `Source text of line ${node.line} contains a line break`,
    );
  }
  return text;
}

/**
 * Escapes `@` so `decodeEscapes(encodeValue(v)) === v`. GEDCOM 5.5.1 doubles
 * runs of two or more `@` and a leading `@` (unless it starts an `@#D` calendar
 * escape); lone `@`s inside text are left as most software writes them.
 * GEDCOM 7 only doubles a leading `@`.
 */
export function encodeValue(value: string, version = 5): string {
  if (!value.includes('@')) return value;
  if (version >= 7) return value.startsWith('@') ? '@' + value : value;
  let out = value.replace(/@{2,}/g, (run) => run + run);
  if (out.startsWith('@') && !out.startsWith('@@') && !out.startsWith('@#')) out = '@' + out;
  return out;
}

const line = (level: number, tag: string, value: string | undefined, xref?: string) =>
  `${level} ${xref === undefined ? '' : xref + ' '}${tag}${value === undefined ? '' : ' ' + value}`;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * A CONC split here keeps every line decodable: not inside a surrogate pair,
 * and never right before an `@`, which could split an `@@` escape or become a
 * GEDCOM 7 leading escape on the next line.
 */
function canCut(s: string, k: number): boolean {
  if (k <= 0 || k >= s.length) return false;
  if (isHigh(s.charCodeAt(k - 1)) && isLow(s.charCodeAt(k))) return false;
  return s[k] !== '@';
}

/** Also away from spaces, which some readers trim from CONC lines. */
const niceCut = (s: string, k: number) => canCut(s, k) && s[k - 1] !== ' ' && s[k] !== ' ';

/**
 * Splits `text` into pieces no longer than `room` where possible, preferring
 * cuts away from spaces. An `@` run longer than `room` stays on one line.
 */
function concPieces(text: string, room: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > room) {
    let cut = room;
    while (cut > 1 && !niceCut(rest, cut)) cut--;
    if (!niceCut(rest, cut)) {
      cut = room;
      while (cut > 1 && !canCut(rest, cut)) cut--;
    }
    if (!canCut(rest, cut)) {
      cut = room;
      while (cut < rest.length && !canCut(rest, cut)) cut++;
      if (cut >= rest.length) break;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/**
 * Whether `value` is still what the raw text decodes to. Either escaping rule
 * counts, so unedited nodes re-emit exactly even if `version` is not passed.
 */
function unedited(
  raw: string | undefined,
  continuations: GedcomNode['continuations'],
  value: string | undefined,
): boolean {
  return (
    composeValue(raw, continuations, 5) === value || composeValue(raw, continuations, 7) === value
  );
}

/** The node's original line if it still says the same thing, else the canonical rendering. */
function headLine(node: GedcomNode, raw: string | undefined): string {
  const canonical = line(node.level, node.tag, raw, node.xref);
  if (node.source === undefined) return canonical;
  const t = parseLine(node.source);
  const same =
    t !== undefined &&
    t.level === node.level &&
    t.tag === node.tag &&
    t.xref === node.xref &&
    t.value === raw;
  return same ? assertSingleLine(node.source, node) : canonical;
}

function pushExtra(out: string[], extra: SkippedLine[] | undefined, node: GedcomNode) {
  if (extra) for (const e of extra) out.push(assertSingleLine(e.text, node));
}

/** Raw text from parsing never holds CR or LF; if it does, re-encode the value instead. */
function rawIsSafe(node: GedcomNode): boolean {
  if (node.rawValue !== undefined && CR_OR_LF.test(node.rawValue)) return false;
  return !node.continuations?.some(
    (c) => CR_OR_LF.test(c.value) || (c.source !== undefined && CR_OR_LF.test(c.source)),
  );
}

function emit(node: GedcomNode, out: string[], options: SerializeOptions) {
  validate(node);
  const { level, tag, xref, pointer, value, continuations } = node;
  const head = pointer === undefined ? node.rawValue : undefined;
  const safe = rawIsSafe(node);

  if (continuations && safe && unedited(head, continuations, value)) {
    // Unedited: the original lines, including Ancestry's bare continuation lines.
    out.push(headLine(node, pointer ?? node.rawValue));
    pushExtra(out, node.extra, node);
    for (const c of continuations) {
      out.push(c.source ?? (c.broken ? c.value : line(c.level, c.tag, c.value || undefined)));
      pushExtra(out, c.extra, node);
    }
  } else {
    let raw: string | undefined;
    let multiLine = false;
    if (pointer !== undefined) {
      raw = pointer;
    } else if (value === undefined) {
      raw = undefined;
    } else if (!continuations && safe && head !== undefined && unedited(head, undefined, value)) {
      raw = head;
    } else {
      const clean = value.replace(CONTROL, '');
      raw = encodeValue(clean, options.version);
      const max = options.maxLineLength ?? Infinity;
      multiLine = LINE_BREAK.test(value) || line(level, tag, raw, xref).length > max;
    }
    if (multiLine) emitValue(level, tag, xref, value!, out, options);
    else out.push(headLine(node, raw));
    pushExtra(out, node.extra, node);
  }
  for (const child of node.children) emit(child, out, options);
}

function emitValue(
  level: number,
  tag: string,
  xref: string | undefined,
  value: string,
  out: string[],
  options: SerializeOptions,
) {
  const max = options.maxLineLength ?? Infinity;
  const sub = level + 1;
  const parts = valueLines(value);
  parts.forEach((part, i) => {
    const encoded = encodeValue(part, options.version);
    const lineTag = i === 0 ? tag : 'CONT';
    const prefix = line(i === 0 ? level : sub, lineTag, '', i === 0 ? xref : undefined).length;
    const pieces = concPieces(encoded, Math.max(1, max - prefix));
    const first = pieces[0]!;
    // A lone empty value keeps its delimiter so it parses back as '' rather than no value.
    const keepEmpty = parts.length === 1 && i === 0;
    out.push(
      i === 0
        ? line(level, tag, first === '' && !keepEmpty ? undefined : first, xref)
        : line(sub, 'CONT', first === '' ? undefined : first),
    );
    const concRoom = Math.max(1, max - line(sub, 'CONC', '').length);
    for (const piece of concPieces(pieces.slice(1).join(''), concRoom)) {
      if (piece !== '') out.push(line(sub, 'CONC', piece));
    }
  });
}

function checkEol(eol = '\n'): string {
  if (eol !== '\n' && eol !== '\r\n' && eol !== '\r') {
    throw new GedcomSerializeError('invalid-eol', 'eol must be \\n, \\r\\n or \\r');
  }
  return eol;
}

/**
 * Re-emits a node and its subtree as GEDCOM text, ending with `eol`. Unedited
 * nodes keep their exact source text. Edited values are re-encoded: every line
 * break (CR, LF, CRLF, U+2028, U+2029, NEL) becomes CONT and other C0 controls
 * except tab are dropped, so a value can never start a new GEDCOM line.
 *
 * @throws GedcomSerializeError for a level, tag, xref or pointer outside the GEDCOM grammar.
 */
export function serializeNode(node: GedcomNode, options: SerializeOptions = {}): string {
  const eol = checkEol(options.eol);
  const out: string[] = [];
  emit(node, out, options);
  return out.join(eol) + eol;
}

/** Re-emits a parse result (without a BOM): preamble lines, then every record. */
export function serializeGedcom(
  doc: Pick<ParseResult, 'records' | 'header'> & Partial<Pick<ParseResult, 'preamble'>>,
  options: SerializeOptions = {},
): string {
  const version = options.version ?? doc.header.majorVersion ?? 5;
  const eol = checkEol(options.eol);
  const preamble = (doc.preamble ?? [])
    .map((p) => {
      if (CR_OR_LF.test(p.text)) {
        throw new GedcomSerializeError(
          'line-break-in-source',
          `Preamble line ${p.line} contains a line break`,
        );
      }
      return p.text + eol;
    })
    .join('');
  return preamble + doc.records.map((r) => serializeNode(r, { ...options, version })).join('');
}
