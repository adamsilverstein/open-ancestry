import { lstatSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

/*
 * A re-import keeps working files in folders inside the tree's folder: a
 * GEDZIP's media waiting for review, and (with the worker compare) the
 * export's own tree. Reviews live in memory for at most REVIEW_MAX_AGE_MS
 * after their last use, and using a review touches its folders, so a folder
 * untouched for longer than that is a crash's leftover. Both the sweep when a
 * tree opens and the one at startup use this one rule, so neither ever
 * removes a folder a live review still needs.
 */

/** The ReimportSessions lifetime: a review unused this long is dropped. */
export const REVIEW_MAX_AGE_MS = 60 * 60 * 1000;

/** `.reimport-` plus mkdtemp's or a UUID's characters, optionally `.oatree`. Nothing else. */
const REIMPORT_FOLDER = /^\.reimport-[A-Za-z0-9-]+(\.oatree)?$/;

export const isReimportFolder = (name: string) => REIMPORT_FOLDER.test(name);

/**
 * Removes the tree's own re-import folders untouched for `minAgeMs`. Only real
 * folders directly inside `treeDir` whose names match exactly: a symlink is
 * never followed or removed. Returns what was removed.
 */
export function sweepReimportFolders(
  treeDir: string,
  minAgeMs = REVIEW_MAX_AGE_MS,
  now = Date.now(),
): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(treeDir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!isReimportFolder(name)) continue;
    const path = join(treeDir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || now - stat.mtimeMs < minAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return removed;
}

/** Marks a review's folder as in use, so the sweeps leave it alone. */
export function touchFolder(path: string | null | undefined): void {
  if (!path) return;
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // Removed meanwhile: nothing to keep.
  }
}
