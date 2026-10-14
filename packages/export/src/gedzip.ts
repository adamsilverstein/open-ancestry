import { treePaths, type MediaRow, type TreeStore } from '@open-ancestry/db';
import { safeEntryPath } from '@open-ancestry/gedcom';
import { zipSync, type Zippable } from 'fflate';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { buildGedcomExport } from './gedcom';
import type { GedzipExport, GedzipExportOptions } from './types';

/** The GEDCOM file's name inside a GEDZIP archive (GEDCOM 7, section 1.2). */
const GEDCOM_ENTRY = 'gedcom.ged';

/** Formats that are already compressed; deflating them again only costs time. */
const STORED = /\.(jpe?g|png|gif|webp|heic|avif|mp3|m4a|ogg|mp4|mov|webm|zip|pdf)$/i;

/**
 * Exports a tree as a GEDZIP archive: GEDCOM 7 in `gedcom.ged` plus every
 * media file the export refers to, at its path under the tree's `media/`
 * folder. Files are read only from inside that folder (symlinks are not
 * followed out of it); missing or refused files are left out with a warning,
 * and their FILE line keeps the relative path.
 */
export function buildGedzipExport(
  store: TreeStore,
  options: GedzipExportOptions = {},
): GedzipExport {
  const root = store.dir ? treePaths(store.dir).media : null;
  const realRoot = root ? safeRealpath(root) : null;
  const files = new Map<string, { entry: string; bytes: Uint8Array }>();
  const entries = new Set<string>([GEDCOM_ENTRY]);
  const warnings: string[] = [];

  const entryName = (path: string): string => {
    let name = path;
    for (let i = 1; entries.has(name.toLowerCase()); i++)
      name = `media/${i > 1 ? `${i}/` : ''}${path}`;
    entries.add(name.toLowerCase());
    return name;
  };

  /** Reads a media file for the archive, once, refusing anything outside the media folder. */
  // `scrub` takes withheld people's names out of a privatized export's file names.
  const filePath = (media: MediaRow, scrub: (text: string) => string): string | undefined => {
    if (!media.local_path) return media.remote_url ? scrub(media.remote_url) : undefined;
    const path = safeEntryPath(media.local_path);
    const shown = scrub(media.local_path);
    let file = files.get(media.id);
    if (!file && path && realRoot) {
      const bytes = readInside(realRoot, join(root!, ...path.split('/')));
      if (bytes) file = { entry: entryName(scrub(path)), bytes };
      else warnings.push(`Media file ${shown} is missing or outside the media folder`);
      if (file) files.set(media.id, file);
    } else if (!file) {
      warnings.push(`Media file ${shown} is not in this tree's media folder`);
    }
    const target = file?.entry ?? (path ? scrub(path) : shown);
    return target.split('/').map(encodeURIComponent).join('/');
  };

  const result = buildGedcomExport(store, {
    ...options,
    version: '7',
    includeMedia: true,
    verbatim: false,
    filePath,
  });
  const zip: Zippable = { [GEDCOM_ENTRY]: new TextEncoder().encode(result.text) };
  for (const { entry, bytes } of files.values()) {
    zip[entry] = [bytes, { level: STORED.test(entry) ? 0 : 6 }];
  }
  return {
    ...result,
    bytes: zipSync(zip, { level: 6 }),
    warnings: [...result.warnings, ...warnings],
  };
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

/** File bytes when `path` resolves to a regular file inside `realRoot`, else undefined. */
function readInside(realRoot: string, path: string): Uint8Array | undefined {
  const real = safeRealpath(path);
  if (!real || !real.startsWith(realRoot + sep)) return undefined;
  try {
    if (!lstatSync(real).isFile()) return undefined;
    return readFileSync(real);
  } catch {
    return undefined;
  }
}
