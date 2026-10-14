import type { BulkCounts, TreeStore } from '@open-ancestry/db';

/** What to import: GEDCOM bytes, a file on disk (GEDCOM or GEDZIP), or GEDZIP bytes. */
export type ImportInput =
  | { bytes: Uint8Array | string; fileName?: string }
  | { path: string }
  | { gedzip: Uint8Array; fileName?: string };

/** Where to import: an empty open tree, or a new tree folder to create (`<name>.oatree`). */
export type ImportTarget = TreeStore | { dir: string; name?: string };

export type ImportPhase = 'read' | 'parse' | 'map' | 'finalize' | 'commit' | 'done';

export interface ImportOptions {
  /** Folder holding the media files a plain GEDCOM refers to. */
  mediaDir?: string;
  /** Called as the import advances; `done`/`total` count records during `map`. */
  onProgress?: (phase: ImportPhase, done: number, total: number) => void;
  /** Aborting rolls the import back (and removes a tree folder it created). */
  signal?: AbortSignal;
  /** Largest GEDCOM or GEDZIP accepted, in bytes (default 256 MiB). */
  maxBytes?: number;
  /** Largest media file copied into the tree, in bytes (default 256 MiB). */
  maxMediaBytes?: number;
  /** Most warnings kept in the report (default 1000); `warningCount` has the total. */
  maxWarnings?: number;
  /** "Now" for living inference (default: the current date). */
  today?: Date;
}

export type ImportWarningCode =
  | 'bad-pointer'
  | 'wrong-pointer-type'
  | 'duplicate-xref'
  | 'duplicate-link'
  | 'duplicate-partner'
  | 'one-sided-link'
  | 'self-relationship'
  | 'relationship-cycle'
  | 'invalid-value'
  | 'media-missing'
  | 'media-unsafe-path'
  | 'media-too-large'
  | 'media-copy-failed'
  | 'home-person'
  | (string & {});

export interface ImportWarning {
  code: ImportWarningCode;
  /** 1-based line in the GEDCOM file, or 0 when it is about the whole file. */
  line: number;
  message: string;
}

export interface UnmappedTag {
  /** Tag path, e.g. `INDI.BIRT._XYZ`. Blank and unparseable lines end in `(blank)` / `(unparsed)`. */
  path: string;
  tag: string;
  count: number;
  example: { line: number; text: string };
}

export interface MissingMedia {
  path: string;
  line: number;
  xref?: string;
}

export interface ImportReport {
  batchId: string;
  /** Tree folder, when the import created one. */
  treeDir: string | null;
  format: 'gedcom-5.5.1' | 'gedcom-7' | 'gedzip';
  encoding: string;
  file: { name: string | null; sha256: string; bytes: number };
  /** `HEAD.SOUR` of the file. */
  source: {
    system: string | null;
    name: string | null;
    version: string | null;
    corp: string | null;
    gedcomVersion: string | null;
    ancestry: { treeName?: string; treeId?: string; env?: string } | null;
  };
  /** Top-level records read, by GEDCOM tag. */
  records: Record<string, number>;
  /** Rows written, by table. */
  rows: BulkCounts;
  warnings: ImportWarning[];
  warningCount: number;
  /** Unmapped lines grouped by tag path, most frequent first. */
  unmapped: UnmappedTag[];
  /**
   * Every physical line is either `mapped` into the domain tables or
   * `preserved` only verbatim (`raw_record`, plus an `unmapped_line` row when
   * it belongs to a mapped record). `mapped + preserved === total`.
   */
  lines: { total: number; mapped: number; preserved: number };
  media: { linked: number; remote: number; missing: MissingMedia[]; rejected: number };
  living: { living: number; deceased: number };
  homePersonId: string | null;
  homePersonSource: 'header' | 'first-person' | null;
  /** Milliseconds per phase. */
  timings: { read: number; parse: number; map: number; commit: number; total: number };
}

export type ImportErrorCode =
  | 'too-large'
  | 'not-gedcom'
  | 'tree-not-empty'
  | 'tree-exists'
  | 'invalid-gedzip'
  | 'aborted'
  | 'read-failed';

/** A refusal to import at all. Bad data inside a GEDCOM never throws; it becomes warnings. */
export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'ImportError';
  }
}
