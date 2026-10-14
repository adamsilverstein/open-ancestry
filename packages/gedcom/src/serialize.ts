import { composeValue } from './parser';
import { parseLine } from './tokenizer';
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

/** Splits `text` into pieces no longer than `room`, never next to a space where avoidable. */
function concPieces(text: string, room: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > room) {
    let cut = room;
    while (cut > 1 && (rest[cut - 1] === ' ' || rest[cut] === ' ')) cut--;
    if (cut <= 1) cut = room;
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
  return same ? node.source : canonical;
}

function pushExtra(out: string[], extra: SkippedLine[] | undefined) {
  if (extra) for (const e of extra) out.push(e.text);
}

function emit(node: GedcomNode, out: string[], options: SerializeOptions) {
  const { level, tag, xref, pointer, value, continuations } = node;
  const head = pointer === undefined ? node.rawValue : undefined;

  if (continuations && unedited(head, continuations, value)) {
    // Unedited: the original lines, including Ancestry's bare continuation lines.
    out.push(headLine(node, pointer ?? node.rawValue));
    pushExtra(out, node.extra);
    for (const c of continuations) {
      out.push(c.source ?? (c.broken ? c.value : line(c.level, c.tag, c.value || undefined)));
      pushExtra(out, c.extra);
    }
  } else {
    let raw: string | undefined;
    let multiLine = false;
    if (pointer !== undefined) {
      raw = pointer;
    } else if (value === undefined) {
      raw = undefined;
    } else if (!continuations && head !== undefined && unedited(head, undefined, value)) {
      raw = head;
    } else {
      raw = encodeValue(value, options.version);
      const max = options.maxLineLength ?? Infinity;
      multiLine = value.includes('\n') || line(level, tag, raw, xref).length > max;
    }
    if (multiLine) emitValue(level, tag, xref, value!, out, options);
    else out.push(headLine(node, raw));
    pushExtra(out, node.extra);
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
  const parts = value.split('\n');
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

/** Re-emits a node and its subtree as GEDCOM text, ending with `eol`. */
export function serializeNode(node: GedcomNode, options: SerializeOptions = {}): string {
  const out: string[] = [];
  emit(node, out, options);
  const eol = options.eol ?? '\n';
  return out.join(eol) + eol;
}

/** Re-emits a parse result (without a BOM): preamble lines, then every record. */
export function serializeGedcom(
  doc: Pick<ParseResult, 'records' | 'header'> & Partial<Pick<ParseResult, 'preamble'>>,
  options: SerializeOptions = {},
): string {
  const version = options.version ?? doc.header.majorVersion ?? 5;
  const eol = options.eol ?? '\n';
  const preamble = (doc.preamble ?? []).map((p) => p.text + eol).join('');
  return preamble + doc.records.map((r) => serializeNode(r, { ...options, version })).join('');
}
