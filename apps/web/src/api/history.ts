import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { ChangeBatchRow } from '@open-ancestry/db';
import { apiGet, seg } from './client';
import { invalidateTree } from './edits';
import { apiSend } from './mutations';
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

/**
 * Undoes or redoes the latest change in the open tree and refetches it.
 * Returns the batch acted on, or null when there was nothing to do.
 */
export async function undoRedo(
  queryClient: QueryClient,
  direction: 'undo' | 'redo',
): Promise<ChangeBatchRow | null> {
  const tree = await queryClient.ensureQueryData(currentTreeQuery);
  if (!tree) return null;
  const { batch } = await apiSend<{ batch: ChangeBatchRow | null }>(
    'POST',
    `/trees/${seg(tree)}/${direction}`,
  );
  await invalidateTree(queryClient, tree);
  return batch;
}
