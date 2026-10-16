import {
  checkMediaPathSync,
  openMediaFile,
  openMediaFileSync,
  treePaths,
  type MediaRefusal,
  type MediaRow,
  type TreeStore,
} from '@open-ancestry/db';
import { safeEntryPath } from '@open-ancestry/gedcom';
import { Zip, ZipDeflate, ZipPassThrough, zipSync, type Zippable } from 'fflate';
import { closeSync, readFileSync, type Stats } from 'node:fs';
import { Readable } from 'node:stream';
import { buildGedcomExport } from './gedcom';
import type { GedcomExport, GedzipExport, GedzipExportOptions } from './types';

/** The GEDCOM file's name inside a GEDZIP archive (GEDCOM 7, section 1.2). */
const GEDCOM_ENTRY = 'gedcom.ged';
/** Problems found while streaming, after the response headers went out. */
const WARNINGS_ENTRY = 'warnings.txt';
/** Characters of warnings.txt kept (at most 4 UTF-8 bytes each, within the 64 KiB reserved). */
const MAX_WARNINGS_TEXT = 15_000;

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
  /** The tree's media folder, and the file's path inside it (opened through the media path rules). */
  root: string;
  localPath: string;
  size: number;
  mtimeMs: number;
  /** Device and inode, so a file swapped for another of the same size and time is noticed. */
  dev: number;
  ino: number;
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
  const files = new Map<string, PlannedFile>();
  // Reserved: media named like either goes under media/.
  const entries = new Set<string>([GEDCOM_ENTRY, WARNINGS_ENTRY]);
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
    if (!file && path && root) {
      let refusal: MediaRefusal = 'missing';
      const found = checkMediaPathSync(root, path, (reason) => (refusal = reason));
      if (found?.info.isFile()) {
        const entry = entryName(path);
        const { size, mtimeMs, dev, ino } = found.info;
        const level = STORED.test(entry) ? 0 : 6;
        file = { entry, root, localPath: path, size, mtimeMs, dev, ino, level };
        files.set(media.id, file);
      } else {
        warnings.push(`Media file ${media.local_path} was left out (${refusal})`);
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
  // Local header, data descriptor and central directory record per entry (names in
  // UTF-8), the data, and for deflated entries deflate's worst case: 5 bytes per
  // stored block of up to 16 KiB, plus a little. Then the end record and, for
  // the warnings entry that may follow, some room.
  const entryBytes = (name: string, size: number, level: 0 | 6) =>
    size +
    (level ? Math.ceil(size / 16_383) * 5 + 64 : 0) +
    30 +
    16 +
    46 +
    2 * Buffer.byteLength(name);
  const archiveBytes =
    planned.reduce((sum, f) => sum + entryBytes(f.entry, f.size, f.level), 0) +
    entryBytes(GEDCOM_ENTRY, Buffer.byteLength(result.text), 6) +
    entryBytes(WARNINGS_ENTRY, 4 * MAX_WARNINGS_TEXT + 1024, 6) +
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
  if (late.length) {
    // Bounded, so the size estimate's room for this entry holds.
    let body = `${late.join('\n')}\n`;
    if (body.length > MAX_WARNINGS_TEXT) {
      body = `${body.slice(0, MAX_WARNINGS_TEXT)}\n... (${late.length} files in all)\n`;
    }
    add(WARNINGS_ENTRY, 6).push(text.encode(body), true);
  }
  zip.end();
  yield* flush();
}

/**
 * Opens a planned file through the media path rules (inside the folder, no
 * symlinked folder, a single link, opened without following a symlink and
 * checked through the descriptor) if it is still the file that was planned.
 */
async function openUnchanged(file: PlannedFile) {
  const opened = await openMediaFile(file.root, file.localPath);
  if (!opened) return undefined;
  if (asPlanned(file, opened.info)) return opened.handle;
  await opened.handle.close();
  return undefined;
}

/** The same file, unchanged since the plan: a swap of the same size and time is caught by inode. */
function asPlanned(file: PlannedFile, info: Stats): boolean {
  return (
    info.dev === file.dev &&
    info.ino === file.ino &&
    info.size === file.size &&
    info.mtimeMs === file.mtimeMs
  );
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
    const opened = openMediaFileSync(file.root, file.localPath);
    try {
      if (!opened || !asPlanned(file, opened.info)) throw new Error('changed');
      zip[file.entry] = [readFileSync(opened.fd), { level: file.level }];
    } catch {
      result.warnings.push(`Media file ${file.entry} could not be read`);
    } finally {
      if (opened) closeSync(opened.fd);
    }
  }
  return { ...result, bytes: zipSync(zip, { level: 6 }) };
}

export function exportGedzip(store: TreeStore, options: GedzipExportOptions = {}): Uint8Array {
  return buildGedzipExport(store, options).bytes;
}
