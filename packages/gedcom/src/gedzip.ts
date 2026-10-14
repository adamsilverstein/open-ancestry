import { unzipSync, type UnzipFileInfo } from 'fflate';

export interface GedzipLimits {
  /** Maximum entries in the archive (default 10,000). */
  maxEntries?: number;
  /** Maximum total uncompressed bytes of the entries read (default 2 GiB). */
  maxTotalSize?: number;
  /** Maximum uncompressed bytes for one entry (default 512 MiB). */
  maxEntrySize?: number;
  /** Maximum uncompressed/compressed ratio for entries over 1 MiB (default 200). */
  maxRatio?: number;
}

export interface GedzipOptions extends GedzipLimits {
  /** Decompress media entries too (default true). Set false to read only the GEDCOM. */
  includeMedia?: boolean;
}

export interface GedzipResult {
  /** Raw GEDCOM bytes; pass to `parseGedcom`. */
  gedcom: Uint8Array;
  gedcomPath: string;
  /** Media bytes by normalized relative path (empty when `includeMedia` is false). */
  media: Map<string, Uint8Array>;
  /** Every safe non-GEDCOM file path in the archive. */
  mediaPaths: string[];
  warnings: string[];
}

export type GedzipErrorCode = 'invalid' | 'too-many-entries' | 'too-large' | 'ratio' | 'no-gedcom';

export class GedzipError extends Error {
  readonly code: GedzipErrorCode;

  constructor(code: GedzipErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'GedzipError';
  }
}

const RATIO_MIN_SIZE = 1024 * 1024;

/** Normalizes an entry name to a safe relative path, or returns undefined if it escapes the root. */
export function safeEntryPath(name: string): string | undefined {
  const path = name.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\0')) return undefined;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return undefined;
    parts.push(part);
  }
  return parts.length ? parts.join('/') : undefined;
}

/**
 * Reads a GEDZIP archive (GEDCOM 7: `gedcom.ged` at the root plus media).
 * Archives with a single `.ged` at the root are accepted with a warning.
 * Limits are checked against the central directory before anything is
 * inflated, and inflation is bounded by the declared size, so a lying header
 * cannot allocate more than the limits allow.
 *
 * @throws GedzipError when the archive is invalid, over a limit, or has no GEDCOM.
 */
export function readGedzip(bytes: Uint8Array, options: GedzipOptions = {}): GedzipResult {
  const {
    maxEntries = 10_000,
    maxTotalSize = 2 * 1024 ** 3,
    maxEntrySize = 512 * 1024 ** 2,
    maxRatio = 200,
    includeMedia = true,
  } = options;

  const warnings: string[] = [];
  const entries: { info: UnzipFileInfo; path: string }[] = [];
  let count = 0;
  const check = (info: UnzipFileInfo): false => {
    if (++count > maxEntries) {
      throw new GedzipError('too-many-entries', `Archive has more than ${maxEntries} entries`);
    }
    if (info.name.endsWith('/')) return false;
    const path = safeEntryPath(info.name);
    if (path === undefined) {
      warnings.push(`Skipped unsafe path in archive: ${JSON.stringify(info.name)}`);
      return false;
    }
    if (info.originalSize > maxEntrySize) {
      throw new GedzipError('too-large', `${path} is larger than ${maxEntrySize} bytes`);
    }
    const ratio = info.originalSize / Math.max(1, info.size);
    if (info.originalSize > RATIO_MIN_SIZE && ratio > maxRatio) {
      throw new GedzipError(
        'ratio',
        `${path} compresses ${Math.round(ratio)}:1; refusing to inflate`,
      );
    }
    entries.push({ info, path });
    return false;
  };

  // First pass reads only the central directory: `check` returns false for every entry.
  try {
    unzipSync(bytes, { filter: check });
  } catch (error) {
    if (error instanceof GedzipError) throw error;
    throw new GedzipError('invalid', `Not a readable zip archive: ${(error as Error).message}`);
  }

  const geds = entries.filter((e) => !e.path.includes('/') && /\.ged$/i.test(e.path));
  const gedEntry =
    geds.find((e) => e.path === 'gedcom.ged') ?? (geds.length === 1 ? geds[0] : undefined);
  if (!gedEntry) {
    throw new GedzipError('no-gedcom', 'Archive has no gedcom.ged (or single .ged) at its root');
  }
  if (gedEntry.path !== 'gedcom.ged') {
    warnings.push(`Archive has no gedcom.ged; using ${gedEntry.path}`);
  }

  const mediaEntries = entries.filter((e) => e !== gedEntry);
  const wanted = new Set([gedEntry.info.name]);
  let total = gedEntry.info.originalSize;
  if (includeMedia) {
    for (const e of mediaEntries) {
      wanted.add(e.info.name);
      total += e.info.originalSize;
    }
  }
  if (total > maxTotalSize) {
    throw new GedzipError('too-large', `Archive expands to more than ${maxTotalSize} bytes`);
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (info) => wanted.has(info.name) });
  } catch (error) {
    throw new GedzipError('invalid', `Could not inflate archive: ${(error as Error).message}`);
  }

  const media = new Map<string, Uint8Array>();
  if (includeMedia) {
    for (const e of mediaEntries) {
      const data = files[e.info.name];
      if (data) media.set(e.path, data);
    }
  }
  return {
    gedcom: files[gedEntry.info.name]!,
    gedcomPath: gedEntry.path,
    media,
    mediaPaths: mediaEntries.map((e) => e.path),
    warnings,
  };
}
