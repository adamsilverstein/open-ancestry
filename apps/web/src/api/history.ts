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

/**
 * Undoes or redoes the latest change in the open tree and refetches it.
 * Returns the batch acted on, or null when there was nothing to do.
 */
export async function undoRedo(
  queryClient: QueryClient,
  direction: 'undo' | 'redo',
): Promise<ChangeBatchRow | null> {
  // From the cache when possible: awaiting here would let an edit fired right
  // after the shortcut join the queue ahead of the undo.
  const cached = queryClient.getQueryData(currentTreeQuery.queryKey);
  const tree = cached !== undefined ? cached : await queryClient.ensureQueryData(currentTreeQuery);
  if (!tree) return null;
  // Undo acts on the latest change on the server, so it joins the edits' queue:
  // it runs after every edit made before it, and an edit made after it (in the
  // gap before the request goes out) waits instead of becoming what is undone.
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationKey: editKey(tree),
    scope: editScope(tree),
    mutationFn: () =>
      apiSend<{ batch: ChangeBatchRow | null }>('POST', `/trees/${seg(tree)}/${direction}`),
  });
  const { batch } = await mutation.execute(undefined);
  await invalidateTree(queryClient, tree);
  return batch;
}
