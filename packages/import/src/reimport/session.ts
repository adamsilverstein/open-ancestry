import { openMemoryTree, type TreeStore } from '@open-ancestry/db';
import { importGedcom } from '../import';
import { rmSync } from 'node:fs';
import { MediaSource } from '../media';
import type { ImportInput, ImportOptions, ImportReport } from '../types';
import { treeRevision } from './apply';
import { diffTrees, localHistory, type ReimportDiff } from './diff';
import { matchPeople, type NearMiss, type PersonMatch } from './match';
import { snapshot } from './snapshot';

/** An updated export read and compared with a tree, waiting for the user's review. */
export interface ReimportSession {
  /** The export, imported into an in-memory tree. Close it with `closeReimport`. */
  incoming: TreeStore;
  report: ImportReport;
  matches: Map<string, PersonMatch>;
  diff: ReimportDiff;
  /** The tree's revision when compared (see `treeRevision`); apply refuses if it moved. */
  baseRevision: string;
  timings: { import: number; compare: number };
  /**
   * The export's media files (a GEDZIP's entries, or `mediaDir`): apply copies
   * the ones accepted changes need into the tree (#75).
   */
  media: MediaSource;
  /** Where a GEDZIP's media files wait for apply (under the tree); removed on close. */
  mediaDir: string | null;
}

/**
 * Reads an updated export and compares it with `store`: who matches whom
 * (with confidence), and every change it would make. Writes nothing.
 */
export async function prepareReimport(
  store: TreeStore,
  input: ImportInput,
  options: Pick<
    ImportOptions,
    'onProgress' | 'signal' | 'maxBytes' | 'maxMediaBytes' | 'today' | 'mediaDir'
  > & {
    /**
     * Gives a folder to keep a GEDZIP's media in while the review waits, so
     * they aren't held in memory. The caller owns it (the server tracks who
     * made it); without one the files stay in memory.
     */
    spillDir?: () => string;
  } = {},
): Promise<ReimportSession> {
  const started = performance.now();
  const incoming = openMemoryTree();
  let mediaDir: string | null = null;
  try {
    let media = MediaSource.none();
    const { spillDir, ...importOptions } = options;
    const report = await importGedcom(input, incoming, {
      ...importOptions,
      onMediaSource: (source) => (media = source),
    });
    // A review can wait an hour: keep a GEDZIP's files on disk, not in memory.
    if (media.inMemory && spillDir) {
      mediaDir = spillDir();
      media = media.spill(mediaDir);
    }
    const imported = performance.now();
    const existingSnap = snapshot(store);
    const incomingSnap = snapshot(incoming);
    const nearMisses = new Map<string, NearMiss>();
    const matches = matchPeople(existingSnap, incomingSnap, nearMisses);
    const diff = diffTrees(existingSnap, incomingSnap, matches, localHistory(store), nearMisses);
    return {
      incoming,
      report,
      matches,
      diff,
      baseRevision: treeRevision(store),
      media,
      mediaDir,
      timings: {
        import: Math.round(imported - started),
        compare: Math.round(performance.now() - imported),
      },
    };
  } catch (error) {
    incoming.close();
    if (mediaDir) rmSync(mediaDir, { recursive: true, force: true });
    throw error;
  }
}

export function closeReimport(session: ReimportSession): void {
  session.incoming.close();
  if (session.mediaDir) rmSync(session.mediaDir, { recursive: true, force: true });
  session.media = MediaSource.none();
}
