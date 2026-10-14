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

export interface UndoRedoResult {
  /** The batch acted on, or null when there was nothing to do. */
  batch: ChangeBatchRow | null;
  /** Newer batches undo stepped over: the NFC upgrade made them impossible to undo. */
  skipped: ChangeBatchRow[];
}

/** Undoes or redoes the latest change in the open tree and refetches it. */
export async function undoRedo(
  queryClient: QueryClient,
  direction: 'undo' | 'redo',
): Promise<UndoRedoResult> {
  const tree = await queryClient.ensureQueryData(currentTreeQuery);
  if (!tree) return { batch: null, skipped: [] };
  const result = await apiSend<Partial<UndoRedoResult>>('POST', `/trees/${seg(tree)}/${direction}`);
  await invalidateTree(queryClient, tree);
  return { batch: result.batch ?? null, skipped: result.skipped ?? [] };
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
