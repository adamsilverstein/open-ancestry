import { openMemoryTree, openTree, type TreeStore } from '@open-ancestry/db';
import { rmSync } from 'node:fs';
import { importGedcom } from '../import';
import { MediaSource } from '../media';
import type { ImportInput, ImportOptions, ImportPhase, ImportReport } from '../types';
import { treeRevision } from './apply';
import { diffTrees, localHistory, type ReimportDiff } from './diff';
import { detectPlaceRenames, matchPeople, type NearMiss, type PersonMatch } from './match';
import { norm, snapshot, statedNameTypes } from './snapshot';

/** An updated export read and compared with a tree, waiting for the user's review. */
export interface ReimportSession {
  /** The export, imported into a tree of its own. Close it with `closeReimport`. */
  incoming: TreeStore;
  /** Where that tree lives on disk (removed on close), or null when it is in memory. */
  incomingDir: string | null;
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
    'signal' | 'maxBytes' | 'maxMediaBytes' | 'today' | 'limits' | 'mediaDir'
  > & {
    onProgress?: (phase: ReimportPhase, done: number, total: number) => void;
    /**
     * Import the export into a new tree in this folder instead of memory, so
     * the compare can run in a worker and hand the review back by path (#161).
     */
    incomingDir?: string;
    /**
     * Gives a folder to keep a GEDZIP's media in while the review waits, so
     * they aren't held in memory. The caller owns it (the server tracks who
     * made it); without one the files stay in memory.
     */
    spillDir?: () => string;
  } = {},
): Promise<ReimportSession> {
  const started = performance.now();
  const { incomingDir, onProgress, spillDir, ...rest } = options;
  let incoming: TreeStore | undefined;
  let mediaDir: string | null = null;
  try {
    let media = MediaSource.none();
    // The import's own 'done' isn't the end of a re-import: the compare follows.
    const importOptions = {
      ...rest,
      onProgress: (phase: ImportPhase, done: number, total: number) => {
        if (phase !== 'done') onProgress?.(phase, done, total);
      },
      onMediaSource: (source: MediaSource) => (media = source),
    };
    let report: ImportReport;
    if (incomingDir) {
      report = await importGedcom(input, { dir: incomingDir }, importOptions);
      incoming = openTree(incomingDir);
    } else {
      incoming = openMemoryTree();
      report = await importGedcom(input, incoming, importOptions);
    }
    // A review can wait an hour: keep a GEDZIP's files on disk, not in memory.
    if (media.inMemory && spillDir) {
      mediaDir = spillDir();
      media = media.spill(mediaDir);
    }
    const imported = performance.now();
    onProgress?.('compare', 0, 1);
    return {
      incoming,
      incomingDir: incomingDir ?? null,
      report,
      comparison: 1,
      ...compare(store, incoming),
      media,
      mediaDir,
      timings: {
        import: Math.round(imported - started),
        compare: Math.round(performance.now() - imported),
      },
    };
  } catch (error) {
    incoming?.close();
    if (incomingDir) rmSync(incomingDir, { recursive: true, force: true });
    if (mediaDir) rmSync(mediaDir, { recursive: true, force: true });
    throw error;
  }
}

/** Phases of a re-import's preparation: the import's, then the compare. */
export type ReimportPhase = Exclude<ImportPhase, 'done'> | 'compare';

/** A prepared review as plain data (what a worker posts back), without its open tree. */
export type ReimportData = Omit<ReimportSession, 'incoming' | 'matches' | 'media'> & {
  incomingDir: string;
  matches: [string, PersonMatch][];
};

export function reimportData(session: ReimportSession): ReimportData {
  if (!session.incomingDir) throw new Error('Only a review prepared on disk can be handed over');
  // The media source isn't data: a spilled GEDZIP's files are reread from mediaDir.
  const { incoming: _incoming, media: _media, matches, ...rest } = session;
  void _incoming;
  void _media;
  return { ...rest, incomingDir: session.incomingDir, matches: [...matches] };
}

/** Reopens a review a worker prepared (see `reimportData`). */
export function reimportFromData(data: ReimportData): ReimportSession {
  return {
    ...data,
    incoming: openTree(data.incomingDir),
    matches: new Map(data.matches),
    media: data.mediaDir ? MediaSource.fromDir(data.mediaDir) : MediaSource.none(),
  };
}

/** Matches and diffs the export against the tree as it is now. */
function compare(store: TreeStore, incoming: TreeStore) {
  const existingSnap = snapshot(store);
  const incomingSnap = snapshot(incoming);
  const nearMisses = new Map<string, NearMiss>();
  // A place the export renamed is one review item, and no reason to doubt a match (#279).
  const renames = detectPlaceRenames(existingSnap, incomingSnap);
  const alias = new Map(renames.map((r) => [norm(r.to), norm(r.from)]));
  const matches = matchPeople(existingSnap, incomingSnap, nearMisses, undefined, alias);
  // In compare, not only prepare, so Compare again keeps the export's stated name types.
  const diff = diffTrees(
    existingSnap,
    incomingSnap,
    matches,
    localHistory(store),
    nearMisses,
    statedNameTypes(incoming),
    renames,
  );
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
  if (session.incomingDir) rmSync(session.incomingDir, { recursive: true, force: true });
  if (session.mediaDir) rmSync(session.mediaDir, { recursive: true, force: true });
  session.media = MediaSource.none();
}
