import { openMemoryTree, type TreeStore } from '@open-ancestry/db';
import { importGedcom } from '../import';
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
  /**
   * Which comparison of this export the review shows: 1, then one more per
   * `refreshReimport`. Change ids are only meaningful within one comparison.
   */
  comparison: number;
  /** The tree's revision when compared (see `treeRevision`); apply refuses if it moved. */
  baseRevision: string;
  timings: { import: number; compare: number };
}

/**
 * Reads an updated export and compares it with `store`: who matches whom
 * (with confidence), and every change it would make. Writes nothing.
 */
export async function prepareReimport(
  store: TreeStore,
  input: ImportInput,
  options: Pick<ImportOptions, 'onProgress' | 'signal' | 'maxBytes' | 'today'> = {},
): Promise<ReimportSession> {
  const started = performance.now();
  const incoming = openMemoryTree();
  try {
    const report = await importGedcom(input, incoming, options);
    const imported = performance.now();
    return {
      incoming,
      report,
      comparison: 1,
      ...compare(store, incoming),
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

/** Matches and diffs the export against the tree as it is now. */
function compare(store: TreeStore, incoming: TreeStore) {
  const existingSnap = snapshot(store);
  const incomingSnap = snapshot(incoming);
  const nearMisses = new Map<string, NearMiss>();
  const matches = matchPeople(existingSnap, incomingSnap, nearMisses);
  const diff = diffTrees(existingSnap, incomingSnap, matches, localHistory(store), nearMisses);
  return { matches, diff, baseRevision: treeRevision(store) };
}

/** Whether the tree changed (an edit, undo or redo) since the review was compared. */
export function isReimportStale(store: TreeStore, session: ReimportSession): boolean {
  return treeRevision(store) !== session.baseRevision;
}

/**
 * Compares the same export again with the tree as it is now (#163), in
 * place: the export is not read again. Change keys stay the same for
 * changes that still say the same thing.
 */
export function refreshReimport(store: TreeStore, session: ReimportSession): ReimportSession {
  const started = performance.now();
  Object.assign(session, compare(store, session.incoming));
  session.comparison++;
  session.timings = { ...session.timings, compare: Math.round(performance.now() - started) };
  return session;
}

export function closeReimport(session: ReimportSession): void {
  session.incoming.close();
}
