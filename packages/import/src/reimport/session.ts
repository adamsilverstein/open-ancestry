import { openMemoryTree, type TreeStore } from '@open-ancestry/db';
import { importGedcom } from '../import';
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
  > = {},
): Promise<ReimportSession> {
  const started = performance.now();
  const incoming = openMemoryTree();
  try {
    let media = MediaSource.none();
    const report = await importGedcom(input, incoming, {
      ...options,
      onMediaSource: (source) => (media = source),
    });
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
      timings: {
        import: Math.round(imported - started),
        compare: Math.round(performance.now() - imported),
      },
    };
  } catch (error) {
    incoming.close();
    throw error;
  }
}

export function closeReimport(session: ReimportSession): void {
  session.incoming.close();
}
