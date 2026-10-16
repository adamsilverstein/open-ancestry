import { Inflate } from 'fflate';

export interface GedzipLimits {
  /** Maximum entries in the archive (default 10,000). */
  maxEntries?: number;
  /** Maximum total uncompressed bytes held in memory for the entries read (default 256 MiB). */
  maxTotalSize?: number;
  /** Maximum uncompressed bytes for one media entry (default 256 MiB). */
  maxEntrySize?: number;
  /**
   * Maximum uncompressed bytes for the GEDCOM file (default 256 MiB), which
   * keeps its decoded text well under V8's maximum string length.
   */
  maxGedcomSize?: number;
  /**
   * Maximum uncompressed/compressed ratio, applied to each entry over 1 MiB
   * and to the entries read in total once they pass 1 MiB (default 200).
   */
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

interface ZipEntry {
  name: string;
  /** The name as stored, compared byte for byte with the local header's. */
  rawName: Uint8Array;
  path: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Compressed bytes fed to the inflater per step, bounding how far one step can overshoot a cap. */
const INFLATE_SLICE = 4096;

const invalid = (message: string) => new GedzipError('invalid', message);

const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp1252 = new TextDecoder('windows-1252');

/**
 * An entry name as text. Bit 11 marks UTF-8, but Info-ZIP and macOS (ditto,
 * Finder) write UTF-8 without it (#287): a name that is valid UTF-8 is read
 * as UTF-8, and only anything else as the legacy code page (CP437, which
 * CP1252 covers for ASCII).
 */
function decodeName(raw: Uint8Array, flags: number): string {
  if (flags & 0x800) return new TextDecoder('utf-8').decode(raw);
  try {
    return utf8.decode(raw);
  } catch {
    return cp1252.decode(raw);
  }
}

/** Reads the end-of-central-directory record and every central directory entry. */
function readCentralDirectory(bytes: Uint8Array, maxEntries: number): Omit<ZipEntry, 'path'>[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw invalid('Not a zip archive (no end of central directory)');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw invalid('ZIP64 archives are not supported');
  if (count > maxEntries) {
    throw new GedzipError('too-many-entries', `Archive has more than ${maxEntries} entries`);
  }

  const entries: Omit<ZipEntry, 'path'>[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) {
      throw invalid('Corrupt central directory');
    }
    const flags = view.getUint16(p + 8, true);
    const nameLength = view.getUint16(p + 28, true);
    const end = p + 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    if (end > bytes.length) throw invalid('Corrupt central directory');
    const rawName = bytes.subarray(p + 46, p + 46 + nameLength);
    const entry = {
      flags,
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      localOffset: view.getUint32(p + 42, true),
      rawName,
      name: decodeName(rawName, flags),
    };
    if ([entry.compressedSize, entry.size, entry.localOffset].includes(0xffffffff)) {
      throw invalid('ZIP64 entries are not supported');
    }
    entries.push(entry);
    p = end;
  }
  return entries;
}

/** Where an entry's local record and compressed data lie, and the name its local header gives. */
function localRecord(bytes: Uint8Array, entry: ZipEntry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.localOffset;
  if (p + 30 > bytes.length || view.getUint32(p, true) !== 0x04034b50) {
    throw invalid(`Corrupt local header for ${entry.path}`);
  }
  const nameLength = view.getUint16(p + 26, true);
  if (p + 30 + nameLength > bytes.length) throw invalid(`Corrupt local header for ${entry.path}`);
  const start = p + 30 + nameLength + view.getUint16(p + 28, true);
  if (start + entry.compressedSize > bytes.length) throw invalid(`${entry.path} is truncated`);
  const rawName = bytes.subarray(p + 30, p + 30 + nameLength);
  return { start, end: start + entry.compressedSize, rawName };
}

/** Returns an entry's compressed bytes, located through its local header. */
function entryData(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const { start, end } = localRecord(bytes, entry);
  return bytes.subarray(start, end);
}

/**
 * Each entry must have a local record of its own (#265): central entries that
 * share or overlap one would inflate the same compressed bytes many times,
 * each looking like an honest ratio. Its local name must match, too.
 */
function assertDistinctRecords(bytes: Uint8Array, entries: ZipEntry[]) {
  const ranges = entries.map((entry) => {
    const { end, rawName } = localRecord(bytes, entry);
    return { entry, start: entry.localOffset, end, rawName };
  });
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ranges.length; i++) {
    const before = ranges[i - 1]!;
    const range = ranges[i]!;
    if (range.start === before.start) {
      throw invalid(`${range.entry.path} shares its data with ${before.entry.path}`);
    }
    if (range.start < before.end) {
      throw invalid(`${range.entry.path} overlaps ${before.entry.path}`);
    }
  }
  // By bytes: a writer may flag UTF-8 (bit 11) in only one of the two headers.
  const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
  for (const { entry, rawName } of ranges) {
    if (!same(rawName, entry.rawName)) {
      throw invalid(
        `${entry.path} is named ${decodeName(rawName, entry.flags)} in its local header`,
      );
    }
  }
}

/** Running totals across every entry inflated in one `readGedzip` call. */
interface Budget {
  produced: number;
  consumed: number;
  maxTotalSize: number;
  maxRatio: number;
}

function charge(budget: Budget, produced: number, consumed: number, path: string) {
  budget.produced += produced;
  budget.consumed += consumed;
  if (budget.produced > budget.maxTotalSize) {
    throw new GedzipError('too-large', `Archive expands to more than ${budget.maxTotalSize} bytes`);
  }
  const ratio = budget.produced / Math.max(1, budget.consumed);
  if (budget.produced > RATIO_MIN_SIZE && ratio > budget.maxRatio) {
    throw new GedzipError(
      'ratio',
      `Archive compresses ${Math.round(ratio)}:1 at ${path}; refusing to inflate`,
    );
  }
}

/**
 * Inflates one entry, counting the bytes actually produced. Inflation stops as
 * soon as the output passes the entry's declared size, or the archive-wide
 * output passes `maxTotalSize` or `maxRatio`, so neither lying headers nor
 * many small high-ratio entries get past the limits.
 */
function inflateEntry(bytes: Uint8Array, entry: ZipEntry, budget: Budget): Uint8Array {
  const data = entryData(bytes, entry);
  if (entry.method === 0) {
    if (data.length !== entry.size) throw invalid(`${entry.path} size does not match its header`);
    charge(budget, data.length, data.length, entry.path);
    return data.slice();
  }
  const chunks: Uint8Array[] = [];
  let produced = 0;
  let consumed = 0;
  const inflater = new Inflate((chunk) => {
    produced += chunk.length;
    if (produced > entry.size) {
      throw invalid(`${entry.path} inflates past its declared ${entry.size} bytes`);
    }
    charge(budget, chunk.length, consumed, entry.path);
    consumed = 0;
    chunks.push(chunk);
  });
  try {
    for (let i = 0; i < data.length; i += INFLATE_SLICE) {
      const end = Math.min(i + INFLATE_SLICE, data.length);
      consumed += end - i;
      inflater.push(data.subarray(i, end), end === data.length);
    }
    if (data.length === 0) inflater.push(data, true);
  } catch (error) {
    if (error instanceof GedzipError) throw error;
    throw invalid(`Could not inflate ${entry.path}: ${(error as Error).message}`);
  }
  // Input that produced no output yet still counts toward the ratio.
  budget.consumed += consumed;
  if (produced !== entry.size) throw invalid(`${entry.path} size does not match its header`);
  const out = new Uint8Array(produced);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Reads a GEDZIP archive (GEDCOM 7: `gedcom.ged` at the root plus media).
 * Archives with a single `.ged` at the root are accepted with a warning.
 * Entry count, sizes and ratios (per entry and in total) are checked against
 * the central directory before anything is inflated. Inflation then counts
 * the bytes it actually produces and aborts the moment an entry exceeds its
 * declared size or the running total exceeds `maxTotalSize` or `maxRatio`.
 *
 * @throws GedzipError when the archive is invalid, over a limit, or has no GEDCOM.
 */
export function readGedzip(bytes: Uint8Array, options: GedzipOptions = {}): GedzipResult {
  const {
    maxEntries = 10_000,
    maxTotalSize = 256 * 1024 ** 2,
    maxEntrySize = 256 * 1024 ** 2,
    maxGedcomSize = 256 * 1024 ** 2,
    maxRatio = 200,
    includeMedia = true,
  } = options;

  const warnings: string[] = [];
  const entries: ZipEntry[] = [];
  // Lowercased paths: case-insensitive file systems would let one overwrite another.
  const seen = new Map<string, string>();
  for (const raw of readCentralDirectory(bytes, maxEntries)) {
    if (raw.name.endsWith('/')) continue;
    const path = safeEntryPath(raw.name);
    if (path === undefined) {
      warnings.push(`Skipped unsafe path in archive: ${JSON.stringify(raw.name)}`);
      continue;
    }
    // Composed and decomposed spellings, like case, name one file on macOS and Windows.
    const folded = path.normalize('NFC').toLowerCase();
    const first = seen.get(folded);
    if (first !== undefined) {
      warnings.push(
        first === path
          ? `Skipped duplicate entry ${path}; kept the first`
          : `Skipped ${path}: same name as ${first} ignoring case and Unicode form; kept the first`,
      );
      continue;
    }
    seen.set(folded, path);
    if (raw.flags & 1 || (raw.method !== 0 && raw.method !== 8)) {
      warnings.push(`Skipped ${path}: encrypted or unsupported compression`);
      continue;
    }
    if (raw.size > maxEntrySize) {
      throw new GedzipError('too-large', `${path} is larger than ${maxEntrySize} bytes`);
    }
    const ratio = raw.size / Math.max(1, raw.compressedSize);
    if (raw.size > RATIO_MIN_SIZE && ratio > maxRatio) {
      throw new GedzipError(
        'ratio',
        `${path} compresses ${Math.round(ratio)}:1; refusing to inflate`,
      );
    }
    entries.push({ ...raw, path });
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
  if (gedEntry.size > maxGedcomSize) {
    throw new GedzipError('too-large', `${gedEntry.path} is larger than ${maxGedcomSize} bytes`);
  }

  const mediaEntries = entries.filter((e) => e !== gedEntry);
  const toRead = includeMedia ? [gedEntry, ...mediaEntries] : [gedEntry];
  assertDistinctRecords(bytes, toRead);
  const total = toRead.reduce((sum, e) => sum + e.size, 0);
  if (total > maxTotalSize) {
    throw new GedzipError('too-large', `Archive expands to more than ${maxTotalSize} bytes`);
  }
  // No more compressed bytes than the archive has, whatever the headers claim.
  const compressed = Math.min(
    bytes.length,
    toRead.reduce((sum, e) => sum + e.compressedSize, 0),
  );
  if (total > RATIO_MIN_SIZE && total / Math.max(1, compressed) > maxRatio) {
    throw new GedzipError(
      'ratio',
      `Archive compresses ${Math.round(total / Math.max(1, compressed))}:1 overall; refusing to inflate`,
    );
  }

  const budget: Budget = { produced: 0, consumed: 0, maxTotalSize, maxRatio };
  const gedcom = inflateEntry(bytes, gedEntry, budget);
  const media = new Map<string, Uint8Array>();
  if (includeMedia) {
    for (const e of mediaEntries) media.set(e.path, inflateEntry(bytes, e, budget));
  }
  return {
    gedcom,
    gedcomPath: gedEntry.path,
    media,
    mediaPaths: mediaEntries.map((e) => e.path),
    warnings,
  };
}
