import { Inflate } from 'fflate';

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

interface ZipEntry {
  name: string;
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
    const entry = {
      flags,
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      localOffset: view.getUint32(p + 42, true),
      // Bit 11 marks UTF-8 names; older tools write CP437, which CP1252 covers for ASCII.
      name: new TextDecoder(flags & 0x800 ? 'utf-8' : 'windows-1252').decode(
        bytes.subarray(p + 46, p + 46 + nameLength),
      ),
    };
    if ([entry.compressedSize, entry.size, entry.localOffset].includes(0xffffffff)) {
      throw invalid('ZIP64 entries are not supported');
    }
    entries.push(entry);
    p = end;
  }
  return entries;
}

/** Returns an entry's compressed bytes, located through its local header. */
function entryData(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.localOffset;
  if (p + 30 > bytes.length || view.getUint32(p, true) !== 0x04034b50) {
    throw invalid(`Corrupt local header for ${entry.path}`);
  }
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  if (start + entry.compressedSize > bytes.length) throw invalid(`${entry.path} is truncated`);
  return bytes.subarray(start, start + entry.compressedSize);
}

/**
 * Inflates one entry, counting the bytes actually produced. Inflation stops as
 * soon as the output passes the size the central directory declared, which the
 * limits were checked against, so a lying header cannot get past them.
 */
function inflateEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const data = entryData(bytes, entry);
  if (entry.method === 0) {
    if (data.length !== entry.size) throw invalid(`${entry.path} size does not match its header`);
    return data.slice();
  }
  const chunks: Uint8Array[] = [];
  let produced = 0;
  const inflater = new Inflate((chunk) => {
    produced += chunk.length;
    if (produced > entry.size) {
      throw invalid(`${entry.path} inflates past its declared ${entry.size} bytes`);
    }
    chunks.push(chunk);
  });
  try {
    for (let i = 0; i < data.length; i += INFLATE_SLICE) {
      const end = Math.min(i + INFLATE_SLICE, data.length);
      inflater.push(data.subarray(i, end), end === data.length);
    }
    if (data.length === 0) inflater.push(data, true);
  } catch (error) {
    if (error instanceof GedzipError) throw error;
    throw invalid(`Could not inflate ${entry.path}: ${(error as Error).message}`);
  }
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
 * Entry count, sizes and ratios are checked against the central directory
 * before anything is inflated, and inflation counts the bytes it actually
 * produces and aborts the moment an entry exceeds its declared size.
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
  const entries: ZipEntry[] = [];
  for (const raw of readCentralDirectory(bytes, maxEntries)) {
    if (raw.name.endsWith('/')) continue;
    const path = safeEntryPath(raw.name);
    if (path === undefined) {
      warnings.push(`Skipped unsafe path in archive: ${JSON.stringify(raw.name)}`);
      continue;
    }
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

  const mediaEntries = entries.filter((e) => e !== gedEntry);
  const toRead = includeMedia ? [gedEntry, ...mediaEntries] : [gedEntry];
  const total = toRead.reduce((sum, e) => sum + e.size, 0);
  if (total > maxTotalSize) {
    throw new GedzipError('too-large', `Archive expands to more than ${maxTotalSize} bytes`);
  }

  const gedcom = inflateEntry(bytes, gedEntry);
  const media = new Map<string, Uint8Array>();
  if (includeMedia) for (const e of mediaEntries) media.set(e.path, inflateEntry(bytes, e));
  return {
    gedcom,
    gedcomPath: gedEntry.path,
    media,
    mediaPaths: mediaEntries.map((e) => e.path),
    warnings,
  };
}
