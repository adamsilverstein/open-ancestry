import { openMemoryTree, type TreeStore } from '@open-ancestry/db';
import { importGedcom } from '../import';
import type { ImportInput, ImportOptions, ImportReport } from '../types';
import { latestBatch } from './apply';
import { diffTrees, locallyEdited, type ReimportDiff } from './diff';
import { matchPeople, type PersonMatch } from './match';
import { snapshot } from './snapshot';

/** An updated export read and compared with a tree, waiting for the user's review. */
export interface ReimportSession {
  /** The export, imported into an in-memory tree. Close it with `closeReimport`. */
  incoming: TreeStore;
  report: ImportReport;
  matches: Map<string, PersonMatch>;
  diff: ReimportDiff;
  /** The tree's newest change batch when compared; apply refuses if it moved. */
  baseBatch: string | null;
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
    const existingSnap = snapshot(store);
    const incomingSnap = snapshot(incoming);
    const matches = matchPeople(existingSnap, incomingSnap);
    const diff = diffTrees(existingSnap, incomingSnap, matches, locallyEdited(store));
    return {
      incoming,
      report,
      matches,
      diff,
      baseBatch: latestBatch(store),
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
