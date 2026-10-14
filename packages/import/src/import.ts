import {
  BulkWriter,
  TreeStore,
  createTree,
  toNFC,
  treePaths,
  type BulkCounts,
  type InsertRow,
  type TableName,
} from '@open-ancestry/db';
import { GedzipError, parseGedcom, readGedzip, type ParseResult } from '@open-ancestry/gedcom';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Mapper, type Sink } from './mapper';
import { MediaSource } from './media';
import {
  ImportError,
  type ImportPhase,
  type ImportInput,
  type ImportOptions,
  type ImportReport,
  type ImportTarget,
} from './types';

const MiB = 1024 ** 2;
const DEFAULT_MAX_BYTES = 256 * MiB;
/** Records mapped between yields to the event loop (for progress and abort). */
const CHUNK = 500;

const ms = (since: number) => Math.round((performance.now() - since) * 10) / 10;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportError('aborted', 'Import was cancelled');
}

function isZip(bytes: Uint8Array | string): bytes is Uint8Array {
  return (
    typeof bytes !== 'string' &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

interface ReadResult {
  gedcom: Uint8Array | string;
  fileName: string | null;
  sha256: string;
  size: number;
  zip: boolean;
  media: MediaSource;
  zipWarnings: string[];
}

function readInput(input: ImportInput, options: ImportOptions): ReadResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let bytes: Uint8Array | string;
  let fileName: string | null = null;
  let zip = false;
  if ('path' in input) {
    fileName = basename(input.path);
    try {
      const size = statSync(input.path).size;
      if (size > maxBytes) throw new ImportError('too-large', `File is over ${maxBytes} bytes`);
      bytes = readFileSync(input.path);
    } catch (error) {
      if (error instanceof ImportError) throw error;
      throw new ImportError('read-failed', `Cannot read ${input.path}`, { cause: error });
    }
  } else if ('gedzip' in input) {
    bytes = input.gedzip;
    fileName = input.fileName ?? null;
    zip = true;
  } else {
    bytes = input.bytes;
    fileName = input.fileName ?? null;
  }
  const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  if (raw.length > maxBytes) throw new ImportError('too-large', `File is over ${maxBytes} bytes`);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  zip ||= isZip(bytes);

  if (!zip) {
    const media = options.mediaDir ? MediaSource.fromDir(options.mediaDir) : MediaSource.none();
    return { gedcom: bytes, fileName, sha256, size: raw.length, zip, media, zipWarnings: [] };
  }
  try {
    const archive = readGedzip(raw, {
      maxGedcomSize: maxBytes,
      maxEntrySize: options.maxMediaBytes ?? DEFAULT_MAX_BYTES,
    });
    return {
      gedcom: archive.gedcom,
      fileName,
      sha256,
      size: raw.length,
      zip,
      media: MediaSource.fromEntries(archive.media),
      zipWarnings: archive.warnings,
    };
  } catch (error) {
    if (error instanceof GedzipError) {
      throw new ImportError(
        error.code === 'too-large' ? 'too-large' : 'invalid-gedzip',
        `Not a usable GEDZIP archive: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function treeName(doc: ParseResult, fileName: string | null): string | undefined {
  const name =
    doc.header.ancestry?.treeName ??
    doc.header.source?.data ??
    (fileName ? fileName.replace(/\.[^.]+$/, '') : undefined);
  return name === undefined ? undefined : toNFC(name);
}

/** Media the import wrote into the tree, for cleanup after a failure. */
interface Copied {
  files: Iterable<string>;
  folders: string[];
}

function openTarget(target: ImportTarget, doc: ParseResult, fileName: string | null) {
  if (target instanceof TreeStore) {
    const used = target.db
      .prepare('SELECT (SELECT count(*) FROM person) + (SELECT count(*) FROM import_batch)')
      .pluck()
      .get() as number;
    if (used > 0) {
      throw new ImportError('tree-not-empty', 'Imports go into a new, empty tree');
    }
    return { store: target, cleanup: (copied: Copied) => void copied };
  }
  if (existsSync(treePaths(target.dir).database)) {
    throw new ImportError('tree-exists', `A tree already exists at ${target.dir}`);
  }
  const paths = treePaths(target.dir);
  const existed = {
    dir: existsSync(paths.root),
    media: existsSync(paths.media),
    thumbs: existsSync(paths.thumbs),
  };
  const store = createTree(target.dir, { name: target.name ?? treeName(doc, fileName) });
  /** Removes what this import created, so a retry into the same folder works. */
  const cleanup = (copied: Copied) => {
    store.close();
    if (!existed.dir) {
      rmSync(paths.root, { recursive: true, force: true });
      return;
    }
    for (const suffix of ['', '-wal', '-shm']) rmSync(paths.database + suffix, { force: true });
    if (!existed.thumbs) rmSync(paths.thumbs, { recursive: true, force: true });
    if (!existed.media) rmSync(paths.media, { recursive: true, force: true });
    else {
      for (const rel of copied.files) rmSync(join(paths.media, ...rel.split('/')), { force: true });
      for (const folder of copied.folders) rmSync(folder, { recursive: true, force: true });
    }
  };
  return { store, cleanup };
}

/**
 * Imports a GEDCOM file (or GEDZIP archive) into a new tree. Bad data never
 * throws: broken pointers, duplicate records and malformed lines become
 * warnings in the report. It throws ImportError only when it cannot import at
 * all (not GEDCOM, too large, target not empty, cancelled), and then leaves
 * the target untouched (a tree folder it created is removed).
 */
export async function importGedcom(
  input: ImportInput,
  target: ImportTarget,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const started = performance.now();
  const progress = options.onProgress ?? (() => {});
  const { signal } = options;
  checkAbort(signal);

  progress('read', 0, 1);
  const read = readInput(input, options);
  const readMs = ms(started);
  progress('read', 1, 1);

  progress('parse', 0, 1);
  const parseStart = performance.now();
  const doc = parseGedcom(read.gedcom, { maxWarnings: options.maxWarnings ?? 1000 });
  const parseMs = ms(parseStart);
  progress('parse', 1, 1);
  const hasHead = doc.records.some((r) => r.tag === 'HEAD');
  if (!hasHead && !doc.records.some((r) => r.tag === 'INDI' || r.tag === 'FAM')) {
    throw new ImportError('not-gedcom', 'The file does not look like GEDCOM');
  }
  checkAbort(signal);

  const created = !(target instanceof TreeStore);
  const { store, cleanup } = openTarget(target, doc, read.fileName);
  let writer: BulkWriter | undefined;
  let mapper: Mapper | undefined;
  try {
    writer = new BulkWriter(store);
    const bulk = writer;
    const rows: Record<string, number> = {};
    const sink: Sink = {
      insert<T extends TableName>(table: T, row: InsertRow<T>) {
        bulk.insert(table, row);
        rows[table] = (rows[table] ?? 0) + 1;
      },
    };

    const header = doc.header;
    const format: ImportReport['format'] = read.zip
      ? 'gedzip'
      : (header.majorVersion ?? 5) >= 7
        ? 'gedcom-7'
        : 'gedcom-5.5.1';
    const batchId = store.newId();
    const startedAt = store.clock();
    sink.insert('import_batch', {
      id: batchId,
      file_name: read.fileName,
      file_sha256: read.sha256,
      format,
      source_software: header.source?.system ?? null,
      source_version: header.source?.version ?? null,
      status: 'running',
      started_at: startedAt,
    });
    if (!created && !store.getRow('meta', 'tree_name')) {
      const name = treeName(doc, read.fileName);
      if (name) sink.insert('meta', { key: 'tree_name', value: name });
    }

    mapper = new Mapper(doc, sink, {
      batchId,
      newId: store.newId,
      media: read.media,
      mediaRoot: store.dir ? treePaths(store.dir).media : null,
      maxMediaBytes: options.maxMediaBytes ?? DEFAULT_MAX_BYTES,
      maxWarnings: options.maxWarnings ?? 1000,
      today: options.today ?? new Date(),
    });
    for (const message of read.zipWarnings) mapper.warn('gedzip', 0, message);
    for (const w of doc.warnings) mapper.warn(w.code, w.line, w.message);
    mapper.warningCount += doc.warningCount - doc.warnings.length;

    const mapStart = performance.now();
    const total = doc.records.length;
    progress('map', 0, total);
    for (let i = 0; i < total; i++) {
      mapper.mapRecord(i);
      if ((i + 1) % CHUNK === 0 && i + 1 < total) {
        progress('map', i + 1, total);
        await tick();
        checkAbort(signal);
      }
    }
    progress('map', total, total);
    checkAbort(signal);

    progress('finalize', 0, 1);
    mapper.finalize();
    const lines = mapper.accountLines();
    const mapMs = ms(mapStart);
    progress('finalize', 1, 1);
    checkAbort(signal);

    const report: ImportReport = {
      batchId,
      treeDir: created ? (target as { dir: string }).dir : store.dir,
      format,
      encoding: doc.encoding.encoding,
      file: { name: read.fileName, sha256: read.sha256, bytes: read.size },
      source: {
        system: header.source?.system ?? null,
        name: header.source?.name ?? null,
        version: header.source?.version ?? null,
        corp: header.source?.corp ?? null,
        gedcomVersion: header.version ?? null,
        ancestry: header.ancestry ?? null,
      },
      records: mapper.recordCounts,
      rows: {},
      warnings: mapper.warnings,
      warningCount: mapper.warningCount,
      unmapped: lines.unmapped,
      lines: { total: lines.total, mapped: lines.mapped, preserved: lines.preserved },
      media: {
        linked: mapper.linkedMedia,
        remote: mapper.remoteMedia,
        missing: mapper.missingMedia,
        rejected: mapper.rejectedMedia,
      },
      living: mapper.living,
      homePersonId: mapper.homePersonId,
      homePersonSource: mapper.homePersonSource,
      timings: { read: readMs, parse: parseMs, map: mapMs, commit: 0, total: 0 },
    };
    store.db
      .prepare(
        "UPDATE import_batch SET status = 'completed', counts_json = ?, warnings_json = ?, finished_at = ? WHERE id = ?",
      )
      .run(
        JSON.stringify({
          records: report.records,
          rows,
          lines: report.lines,
          media: { ...report.media, missing: report.media.missing.length },
          living: report.living,
          unmapped: report.unmapped.slice(0, 200),
        }),
        JSON.stringify(report.warnings),
        store.clock(),
        batchId,
      );

    progress('commit', 0, 1);
    const commitStart = performance.now();
    const committed: BulkCounts = writer.commit();
    report.timings.commit = ms(commitStart);
    report.rows = committed;
    progress('commit', 1, 1);
    if (created) store.close();
    report.timings.total = ms(started);
    progress('done', 1, 1);
    return report;
  } catch (error) {
    writer?.rollback();
    cleanup({ files: mapper?.copiedMedia ?? [], folders: mapper?.createdMediaFolders ?? [] });
    throw error;
  }
}

/**
 * `importGedcom` shaped for the server's injected `Importer` (apps/server
 * jobs.ts): reads the uploaded file at `path` into the empty `store` and
 * reports progress as `{ phase, done, total }` objects. Media come from a
 * GEDZIP upload; a plain GEDCOM upload has no media folder to read from.
 */
export function importFile(
  path: string,
  store: TreeStore,
  options: {
    onProgress?: (progress: { phase: ImportPhase; done: number; total: number }) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ImportReport> {
  const { onProgress, signal } = options;
  return importGedcom({ path }, store, {
    ...(signal && { signal }),
    ...(onProgress && { onProgress: (phase, done, total) => onProgress({ phase, done, total }) }),
  });
}
