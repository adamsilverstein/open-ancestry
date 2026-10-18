import { isolate } from '@open-ancestry/core';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { ChangeBatchRow } from '@open-ancestry/db';
import { apiGet, seg } from './client';
import { editKey, editScope, invalidateTree } from './edits';
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

/**
 * People this session just deleted, by when: their page can still be mounted
 * for a moment and see the 404, which must not read as a delete made elsewhere.
 */
const leaving = new Map<string, number>();
/** That moment is short; after it, a 404 for the person is someone else's doing. */
const LEAVING_MS = 5_000;

/** Records that change batch `batchId` deleted person `personId`. */
export function rememberDeletedPerson(batchId: string, personId: string): void {
  deletedPeople.set(batchId, personId);
  leaving.set(personId, Date.now());
  if (deletedPeople.size > MAX_REMEMBERED) {
    deletedPeople.delete(deletedPeople.keys().next().value!);
  }
}

/**
 * Whether this session just deleted `personId` itself, so its page should not
 * announce the delete as one made elsewhere. Answers once: a later delete (say,
 * after an undo in another tab) is announced.
 */
export function deletedHere(personId: string): boolean {
  const at = leaving.get(personId);
  leaving.delete(personId);
  return at !== undefined && Date.now() - at < LEAVING_MS;
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
  // From the cache when possible: awaiting here would let an edit fired right
  // after the shortcut join the queue ahead of the undo.
  const cached = queryClient.getQueryData(currentTreeQuery.queryKey);
  const tree = cached !== undefined ? cached : await queryClient.ensureQueryData(currentTreeQuery);
  if (!tree) return { batch: null, skipped: [] };
  // Undo acts on the latest change on the server, so it joins the edits' queue:
  // it runs after every edit made before it, and an edit made after it (in the
  // gap before the request goes out) waits instead of becoming what is undone.
  const query = expect ? `?expect=${seg(expect)}` : '';
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationKey: editKey(tree),
    scope: editScope(tree),
    mutationFn: () =>
      apiSend<Partial<UndoRedoResult>>('POST', `/trees/${seg(tree)}/${direction}${query}`),
  });
  const result = await mutation.execute(undefined);
  await invalidateTree(queryClient, tree);
  const batch = result.batch ?? null;
  // Undoing a delete brings the person back: the caller goes to them.
  const restored = direction === 'undo' && batch ? deletedPeople.get(batch.id) : undefined;
  if (restored) leaving.delete(restored);
  if (restored) await onRestored?.(restored);
  return { batch, skipped: result.skipped ?? [] };
}

/**
 * The toast for an undo or redo: what changed, and what was stepped over.
 * Labels are stored text (often built from names), so they are cleaned and isolated (#264).
 */
export function undoRedoMessage(
  action: 'undo' | 'redo',
  { batch, skipped }: UndoRedoResult,
): { title: string; description?: string } {
  const title = batch
    ? `${action === 'undo' ? 'Undid' : 'Redid'} ${isolate(batch.label)}`
    : `Nothing to ${action}`;
  if (skipped.length === 0) return { title };
  const names = skipped.map((b) => `"${isolate(b.label)}"`).join(', ');
  return { title, description: `Skipped ${names} (can't be undone after the upgrade)` };
}
