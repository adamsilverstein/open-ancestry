import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { ChangeBatchRow } from '@open-ancestry/db';
import { apiGet, seg } from './client';
import { invalidateTree } from './edits';
import { apiSend } from './client';
import { currentTreeQuery } from './queries';

export interface History {
  items: ChangeBatchRow[];
  canUndo: boolean;
  canRedo: boolean;
}

export const historyQuery = (tree: string) =>
  queryOptions({
    queryKey: ['history', tree],
    queryFn: ({ signal }) => apiGet<History>(`/trees/${seg(tree)}/history?limit=50`, signal),
  });

/** Delete batches this session made, so undoing one can open the restored person. */
const deletedPeople = new Map<string, string>();
/** Only recent deletes matter for undo; older entries are dropped. */
const MAX_REMEMBERED = 50;

/** People this session just deleted, until their page has left (or an undo restores them). */
const leaving = new Set<string>();

/** Records that change batch `batchId` deleted person `personId`. */
export function rememberDeletedPerson(batchId: string, personId: string): void {
  deletedPeople.set(batchId, personId);
  leaving.add(personId);
  if (deletedPeople.size > MAX_REMEMBERED) {
    deletedPeople.delete(deletedPeople.keys().next().value!);
  }
}

/**
 * Whether this session deleted `personId` itself (and nothing restored them),
 * so its page should not announce the delete as one made elsewhere.
 */
export function deletedHere(personId: string): boolean {
  return leaving.has(personId);
}

export interface UndoRedoResult {
  /** The batch acted on, or null when there was nothing to do. */
  batch: ChangeBatchRow | null;
  /** Newer batches undo stepped over: the NFC upgrade made them impossible to undo. */
  skipped: ChangeBatchRow[];
}

export interface UndoRedoOptions {
  /**
   * Undo only this batch, and only while it is the newest (a toast's Undo); the
   * server refuses otherwise with `not_newest`.
   */
  expect?: string;
  /** Called with a person an undone delete brought back, so the caller can open them. */
  onRestored?: (personId: string) => unknown;
}

/** Undoes or redoes the latest change in the open tree and refetches it. */
export async function undoRedo(
  queryClient: QueryClient,
  direction: 'undo' | 'redo',
  { expect, onRestored }: UndoRedoOptions = {},
): Promise<UndoRedoResult> {
  const tree = await queryClient.ensureQueryData(currentTreeQuery);
  if (!tree) return { batch: null, skipped: [] };
  const query = expect ? `?expect=${seg(expect)}` : '';
  const result = await apiSend<Partial<UndoRedoResult>>(
    'POST',
    `/trees/${seg(tree)}/${direction}${query}`,
  );
  await invalidateTree(queryClient, tree);
  const batch = result.batch ?? null;
  // Undoing a delete brings the person back: the caller goes to them.
  const restored = direction === 'undo' && batch ? deletedPeople.get(batch.id) : undefined;
  if (restored) leaving.delete(restored);
  if (restored) await onRestored?.(restored);
  return { batch, skipped: result.skipped ?? [] };
}

/** The toast for an undo or redo: what changed, and what was stepped over. */
export function undoRedoMessage(
  action: 'undo' | 'redo',
  { batch, skipped }: UndoRedoResult,
): { title: string; description?: string } {
  const title = batch
    ? `${action === 'undo' ? 'Undid' : 'Redid'} ${batch.label}`
    : `Nothing to ${action}`;
  if (skipped.length === 0) return { title };
  const names = skipped.map((b) => `"${b.label}"`).join(', ');
  return { title, description: `Skipped ${names} (can't be undone after the upgrade)` };
}
