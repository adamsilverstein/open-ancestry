import { treePaths, type MediaRow, type TreeStore } from '@open-ancestry/db';
import { safeEntryPath } from '@open-ancestry/gedcom';
import { Zip, ZipDeflate, ZipPassThrough, zipSync, type Zippable } from 'fflate';
import { constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { buildGedcomExport } from './gedcom';
import type { GedcomExport, GedzipExport, GedzipExportOptions } from './types';

/** The GEDCOM file's name inside a GEDZIP archive (GEDCOM 7, section 1.2). */
const GEDCOM_ENTRY = 'gedcom.ged';
/** Problems found while streaming, after the response headers went out. */
const WARNINGS_ENTRY = 'warnings.txt';

/** Formats that are already compressed; deflating them again only costs time. */
const STORED = /\.(jpe?g|png|gif|webp|heic|avif|mp3|m4a|ogg|mp4|mov|webm|zip|pdf)$/i;

/** fflate writes no ZIP64: no archive or entry past 4 GiB, at most 65535 entries. */
const ZIP32_MAX_BYTES = 2 ** 32 - 1;
const ZIP32_MAX_ENTRIES = 0xffff;
/** Bytes read from a media file per step of a streamed export. */
const CHUNK = 1024 * 1024;

/** A GEDZIP the archive format cannot hold (over 4 GiB, or too many files). */
export class GedzipTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GedzipTooLargeError';
  }
}

export interface GedzipPlanOptions extends GedzipExportOptions {
  /** Largest archive to plan, in bytes (default and maximum: 4 GiB, as ZIP64 is not written). */
  maxArchiveBytes?: number;
}

/** A media file to add to the archive, as it was when the export was planned. */
interface PlannedFile {
  entry: string;
  /** Real path, inside the tree's media folder. */
  path: string;
  size: number;
  mtimeMs: number;
  level: 0 | 6;
}

/**
 * Everything a GEDZIP export holds, taken in one synchronous pass so the
 * GEDCOM text and the media list are one snapshot: the text, and each media
 * file's entry name, path, size and modification time. The bytes are read
 * later, by `streamGedzip`.
 */
export interface GedzipPlan extends GedcomExport {
  files: PlannedFile[];
  /** About how large the archive will be, in bytes. */
  archiveBytes: number;
}

/**
 * Plans a GEDZIP export: GEDCOM 7 for `gedcom.ged` plus every media file the
 * export refers to, at its path under the tree's `media/` folder. Files are
 * taken only from inside that folder (symlinks are not followed out of it);
 * missing or refused files are left out with a warning, and their FILE line
 * keeps the relative path. Throws GedzipTooLargeError for an archive the
 * format cannot hold, before anything is sent.
 */
export function planGedzipExport(
  store: TreeStore,
  { maxArchiveBytes = ZIP32_MAX_BYTES, ...options }: GedzipPlanOptions = {},
): GedzipPlan {
  const root = store.dir ? treePaths(store.dir).media : null;
  const realRoot = root ? safeRealpath(root) : null;
  const files = new Map<string, PlannedFile>();
  const entries = new Set<string>([GEDCOM_ENTRY]);
  const warnings: string[] = [];

  const entryName = (path: string): string => {
    let name = path;
    for (let i = 1; entries.has(name.toLowerCase()); i++)
      name = `media/${i > 1 ? `${i}/` : ''}${path}`;
    entries.add(name.toLowerCase());
    return name;
  };

  /** Notes a media file for the archive, once, refusing anything outside the media folder. */
  const filePath = (media: MediaRow): string | undefined => {
    if (!media.local_path) return media.remote_url ?? undefined;
    const path = safeEntryPath(media.local_path);
    let file = files.get(media.id);
    if (!file && path && realRoot) {
      const found = statInside(realRoot, join(root!, ...path.split('/')));
      if (found) {
        const entry = entryName(path);
        file = { entry, ...found, level: STORED.test(entry) ? 0 : 6 };
        files.set(media.id, file);
      } else {
        warnings.push(`Media file ${media.local_path} is missing or outside the media folder`);
      }
    } else if (!file) {
      warnings.push(`Media file ${media.local_path} is not in this tree's media folder`);
    }
    const target = file?.entry ?? path ?? media.local_path;
    return target.split('/').map(encodeURIComponent).join('/');
  };

  const result = buildGedcomExport(store, {
    ...options,
    version: '7',
    includeMedia: true,
    verbatim: false,
    filePath,
  });
  const planned = [...files.values()];
  // Local header, data descriptor and central directory record per entry, plus the end record.
  const entryBytes = (name: string, size: number) => size + 30 + 16 + 46 + 2 * name.length;
  const archiveBytes =
    planned.reduce((sum, f) => sum + entryBytes(f.entry, f.size), 0) +
    entryBytes(GEDCOM_ENTRY, Buffer.byteLength(result.text)) +
    22;
  const limit = Math.min(maxArchiveBytes, ZIP32_MAX_BYTES);
  if (archiveBytes > limit) {
    throw new GedzipTooLargeError(
      `The GEDZIP would be ${archiveBytes} bytes, over ${limit} bytes, the largest archive this export can write. Export GEDCOM and copy the media folder instead.`,
    );
  }
  if (planned.length + 2 > ZIP32_MAX_ENTRIES) {
    throw new GedzipTooLargeError(
      `The GEDZIP would hold ${planned.length} media files, over the ${ZIP32_MAX_ENTRIES - 2} this export can write.`,
    );
  }
  return { ...result, files: planned, archiveBytes, warnings: [...result.warnings, ...warnings] };
}

/**
 * Streams a planned GEDZIP: `gedcom.ged`, then each media file read in 1 MiB
 * steps, so memory holds one step at a time and the event loop is never held
 * for a whole file. A media file that changed or vanished since the plan is
 * left out and named in a final `warnings.txt` entry, since the response
 * headers have gone by then.
 */
export function streamGedzip(plan: GedzipPlan): Readable {
  return Readable.from(gedzipChunks(plan), { objectMode: false });
}

async function* gedzipChunks(plan: GedzipPlan): AsyncGenerator<Uint8Array> {
  const out: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((error, data) => {
    if (error) failure = error;
    else out.push(data);
  });
  const flush = function* () {
    if (failure) throw failure;
    while (out.length) yield out.shift()!;
  };
  const add = (name: string, level: 0 | 6) => {
    const entry = level ? new ZipDeflate(name, { level }) : new ZipPassThrough(name);
    zip.add(entry);
    return entry;
  };
  const text = new TextEncoder();

  add(GEDCOM_ENTRY, 6).push(text.encode(plan.text), true);
  yield* flush();

  const late: string[] = [];
  for (const file of plan.files) {
    const handle = await openUnchanged(file);
    if (!handle) {
      late.push(`Media file ${file.entry} changed or went missing during the export; left out`);
      continue;
    }
    try {
      const entry = add(file.entry, file.level);
      const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(1, file.size)));
      let read = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, read);
        if (bytesRead === 0) break;
        read += bytesRead;
        // The output may hold this chunk until it is read, and the buffer is reused: copy.
        entry.push(buffer.subarray(0, bytesRead).slice(), false);
        yield* flush();
      }
      entry.push(new Uint8Array(0), true);
      if (read !== file.size) late.push(`Media file ${file.entry} changed during the export`);
      yield* flush();
    } finally {
      await handle.close();
    }
  }
  if (late.length) add(WARNINGS_ENTRY, 6).push(text.encode(`${late.join('\n')}\n`), true);
  zip.end();
  yield* flush();
}

/** Opens a planned file if it is still the same regular file inside the media folder. */
async function openUnchanged(file: PlannedFile) {
  if (safeRealpath(file.path) !== file.path) return undefined;
  try {
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (stat.isFile() && stat.size === file.size && stat.mtimeMs === file.mtimeMs) return handle;
    await handle.close();
  } catch {
    // Gone or replaced: left out.
  }
  return undefined;
}

/**
 * Exports a tree as a GEDZIP archive in memory (see `planGedzipExport`). The
 * server streams with `streamGedzip` instead; this suits small trees and tools.
 */
export function buildGedzipExport(
  store: TreeStore,
  options: GedzipExportOptions = {},
): GedzipExport {
  const { files, ...plan } = planGedzipExport(store, options);
  const result: GedcomExport = {
    text: plan.text,
    xrefs: plan.xrefs,
    stats: plan.stats,
    warnings: plan.warnings,
  };
  const zip: Zippable = { [GEDCOM_ENTRY]: new TextEncoder().encode(result.text) };
  for (const file of files) {
    try {
      zip[file.entry] = [readFileSync(file.path), { level: file.level }];
    } catch {
      result.warnings.push(`Media file ${file.entry} could not be read`);
    }
  }
  return { ...result, bytes: zipSync(zip, { level: 6 }) };
}

export function exportGedzip(store: TreeStore, options: GedzipExportOptions = {}): Uint8Array {
  return buildGedzipExport(store, options).bytes;
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Real path, size and mtime when `path` resolves to a regular file inside `realRoot`. */
function statInside(
  realRoot: string,
  path: string,
): { path: string; size: number; mtimeMs: number } | undefined {
  const real = safeRealpath(path);
  if (!real || !real.startsWith(realRoot + sep)) return undefined;
  try {
    const stat = lstatSync(real);
    return stat.isFile() ? { path: real, size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}
