import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast/Toast';
import { isStale } from './client';
import { personQuery } from './queries';
import type { PersonDetail } from './types';

/*
 * One hook for every edit: optional optimistic update of the cached person
 * detail, rollback with a toast on error, then a refetch of everything that
 * belongs to the tree (people, search, history, tags...).
 */

export interface Edit<T = unknown> {
  /** Short label for errors, e.g. `Edit name`. */
  label: string;
  send: () => Promise<T>;
  /** Applied to the cached detail of `personId` before the request. */
  optimistic?: { personId: string; update: (detail: PersonDetail) => PersonDetail };
  /** Runs after success, before queries refetch (e.g. navigate away from a deleted person). */
  onDone?: (result: T) => void;
  /** Runs after the rollback and error toast, e.g. so a dialog can show the error and stay open. */
  onError?: (error: unknown) => void;
}

const changeListeners = new Set<(tree: string) => void>();

/**
 * Tells views that keep tree data outside the query cache (the tree view's
 * merged neighborhoods) that `tree` changed. Unlike query invalidation, this
 * does not depend on any query still being in the cache.
 */
export function onTreeChanged(listener: (tree: string) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** Other tabs of the app on this origin; edits, undo and redo are tree-wide on the server. */
const otherTabs = typeof BroadcastChannel === 'function' ? new BroadcastChannel('oa-tree') : null;

/**
 * Refetches every query of the tree (keys are `[kind, tree, ...]`), notifies
 * `onTreeChanged`, and tells other tabs to do the same unless the change came from one.
 */
export function invalidateTree(
  queryClient: QueryClient,
  tree: string,
  { fromOtherTab = false } = {},
) {
  for (const listener of changeListeners) listener(tree);
  if (!fromOtherTab) otherTabs?.postMessage({ tree });
  return queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] === tree });
}

/** Refreshes this tab's copy of a tree whenever another tab changes it; returns a stop function. */
export function syncTreesAcrossTabs(queryClient: QueryClient): () => void {
  const onMessage = (event: MessageEvent<unknown>) => {
    const { tree } = (event.data ?? {}) as { tree?: unknown };
    if (typeof tree === 'string') void invalidateTree(queryClient, tree, { fromOtherTab: true });
  };
  otherTabs?.addEventListener('message', onMessage);
  return () => otherTabs?.removeEventListener('message', onMessage);
}

interface Run {
  edit: Edit;
  /** The detail before the optimistic update, for rollback. */
  rollback: { key: readonly unknown[]; previous: PersonDetail } | null;
}

export function useEdit(tree: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: ({ edit }: Run) => edit.send(),
    onError: (error, { edit, rollback }) => {
      if (rollback) queryClient.setQueryData(rollback.key, rollback.previous);
      toast(
        isStale(error)
          ? {
              title: 'Not saved',
              description: `${edit.label}: this changed in another window (or by undo) after you opened it, so nothing was saved. Open it again to start from the latest.`,
              variant: 'error',
            }
          : {
              title: 'Could not save',
              description: `${edit.label}: ${error instanceof Error ? error.message : String(error)}`,
              variant: 'error',
            },
      );
      edit.onError?.(error);
    },
    onSuccess: (result, { edit }) => edit.onDone?.(result),
    onSettled: () => invalidateTree(queryClient, tree),
  });

  /**
   * Starts an edit. The optimistic update is applied synchronously, in the same
   * event as the click, so a controlled checkbox or field never flips back.
   */
  const mutate = <T>(edit: Edit<T>) => {
    let rollback: Run['rollback'] = null;
    if (edit.optimistic) {
      const { queryKey } = personQuery(tree, edit.optimistic.personId);
      // A refetch in flight would overwrite the optimistic detail; no revert, or
      // the cancelled fetch would restore the old data over ours.
      void queryClient.cancelQueries({ queryKey }, { revert: false, silent: true });
      const previous = queryClient.getQueryData(queryKey);
      if (previous) {
        queryClient.setQueryData(queryKey, edit.optimistic.update(previous));
        rollback = { key: queryKey, previous };
      }
    }
    mutation.mutate({ edit: edit as Edit, rollback });
  };

  return { mutate, isPending: mutation.isPending };
}
