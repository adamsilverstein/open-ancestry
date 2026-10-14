/** Character encodings the decoder understands. */
export type GedcomEncoding =
  'utf-8' | 'utf-16le' | 'utf-16be' | 'ansel' | 'ascii' | 'windows-1252' | 'macintosh';

export interface EncodingInfo {
  encoding: GedcomEncoding;
  /** How the encoding was chosen. */
  source: 'bom' | 'header' | 'sniff' | 'option';
  /** Raw `HEAD.CHAR` value found in the bytes, if any. */
  declared?: string;
  bom: boolean;
}

export type WarningCode =
  | 'invalid-bytes'
  | 'encoding-fallback'
  | 'charset-mismatch'
  | 'replacement-char'
  | 'broken-line'
  | 'skipped-line'
  | 'malformed-line'
  | 'decode-failed'
  | 'level-jump'
  | 'level-format'
  | 'orphan-line'
  | 'misplaced-continuation'
  | 'duplicate-xref'
  | 'missing-head'
  | 'missing-trlr'
  | 'after-trlr';

export interface GedcomWarning {
  code: WarningCode;
  /** 1-based source line, or 0 when the warning is about the whole file. */
  line: number;
  message: string;
}

/** A CONC or CONT line merged into its parent's value. */
export interface Continuation {
  tag: 'CONC' | 'CONT';
  level: number;
  line: number;
  /** Raw (still escaped) text after the tag, or the whole line when `broken`. */
  value: string;
  /**
   * Line had no level or tag (Ancestry writes multi-line notes as bare lines).
   * It is treated as CONT and re-emitted exactly as found.
   */
  broken?: true;
  /** Original line text, present only when it differs from the canonical rendering. */
  source?: string;
  /** Blank or unparseable lines that followed this line, re-emitted after it. */
  extra?: SkippedLine[];
}

export interface GedcomNode {
  level: number;
  tag: string;
  /** Record id including the `@`s, e.g. `@I1@`. */
  xref?: string;
  /** Pointer value including the `@`s, e.g. `@F2@` or `@VOID@`. */
  pointer?: string;
  /** Decoded value with `@@` escapes resolved and CONC/CONT merged (CONT becomes `\n`). */
  value?: string;
  children: GedcomNode[];
  /** 1-based source line of this node's own line. */
  line: number;
  /** Raw head-line value, present when it contains `@` or continuations follow. */
  rawValue?: string;
  /** CONC/CONT lines merged into `value`, in source order. */
  continuations?: Continuation[];
  /**
   * Original line text, present only when it differs from the canonical
   * rendering (indentation, tabs, repeated spaces, `01` levels, repaired lines).
   */
  source?: string;
  /** Blank or unparseable lines that followed this node's own line, re-emitted after it. */
  extra?: SkippedLine[];
}

export interface SkippedLine {
  line: number;
  text: string;
}

/**
 * Where every physical source line went. `nodes + continuations + blank + skipped === total`.
 * Blank and skipped lines inside a record are attached to it (`extra`); the
 * `detached` ones before the first record are in `preamble`. So the
 * `subtreeLines` of all records plus `detached` also equals `total`.
 */
export interface LineAccounting {
  total: number;
  nodes: number;
  continuations: number;
  blank: number;
  skipped: number;
  detached: number;
}

export interface AncestryInfo {
  treeName?: string;
  /** `HEAD.SOUR._TREE.RIN`, the Ancestry tree id. */
  treeId?: string;
  env?: string;
}

export interface HeaderInfo {
  /** `HEAD.GEDC.VERS`, e.g. `5.5.1` or `7.0.14`. */
  version?: string;
  majorVersion?: number;
  form?: string;
  /** `HEAD.CHAR` as written in the file. */
  charset?: string;
  source?: {
    system: string;
    name?: string;
    version?: string;
    corp?: string;
    /** `HEAD.SOUR.DATA` value; Ancestry puts the tree name here. */
    data?: string;
  };
  /** Present when the file came from Ancestry.com. */
  ancestry?: AncestryInfo;
  destination?: string;
  date?: string;
  language?: string;
  filename?: string;
  submitter?: string;
  /** GEDCOM 7 `HEAD.SCHMA.TAG` extension tag definitions: tag -> URI. */
  schema: Record<string, string>;
}

export interface ParseOptions {
  /** Skip detection and decode with this encoding. */
  encoding?: GedcomEncoding;
  /** Maximum warnings kept in `warnings` (default 1000); `warningCount` keeps the total. */
  maxWarnings?: number;
}

export interface ParseResult {
  encoding: EncodingInfo;
  header: HeaderInfo;
  /** Level-0 records in source order (including HEAD and TRLR). */
  records: GedcomNode[];
  /** Level-0 records by xref. The first record wins when an xref is duplicated. */
  index: Map<string, GedcomNode>;
  warnings: GedcomWarning[];
  warningCount: number;
  /** Number of physical lines in the source. */
  lineCount: number;
  lines: LineAccounting;
  /** Every line that could not be parsed (also kept in `extra` or `preamble`). */
  skipped: SkippedLine[];
  /** Blank or unparseable lines before the first record. */
  preamble: SkippedLine[];
}
