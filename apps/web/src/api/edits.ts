import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast/Toast';
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

/** Refetches every query of the tree (keys are `[kind, tree, ...]`) and notifies `onTreeChanged`. */
export function invalidateTree(queryClient: QueryClient, tree: string) {
  for (const listener of changeListeners) listener(tree);
  return queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] === tree });
}

/** Every edit to `tree` shares this key, so they can be counted and awaited. */
export const editKey = (tree: string) => ['edit', tree] as const;

/** Resolves once no edit to `tree` is pending or queued. */
export function editsSettled(queryClient: QueryClient, tree: string): Promise<void> {
  const pending = () => queryClient.isMutating({ mutationKey: editKey(tree) }) > 0;
  if (!pending()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = queryClient.getMutationCache().subscribe(() => {
      if (pending()) return;
      unsubscribe();
      resolve();
    });
  });
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
    mutationKey: editKey(tree),
    // One at a time, in the order they were made: a slow request can never land
    // after a later one (TanStack runs mutations sharing a scope serially).
    scope: { id: `edit:${tree}` },
    mutationFn: ({ edit }: Run) => edit.send(),
    onError: (error, { edit, rollback }) => {
      if (rollback) queryClient.setQueryData(rollback.key, rollback.previous);
      toast({
        title: 'Could not save',
        description: `${edit.label}: ${error instanceof Error ? error.message : String(error)}`,
        variant: 'error',
      });
    },
    onSuccess: (result, { edit }) => edit.onDone?.(result),
    // Refetch once the queue drains: a refetch between queued edits would show
    // server state without them and overwrite their optimistic updates.
    // (This edit still counts as pending while onSettled runs.)
    onSettled: () =>
      queryClient.isMutating({ mutationKey: editKey(tree) }) > 1
        ? undefined
        : invalidateTree(queryClient, tree),
  });

  /**
   * Starts an edit. The optimistic update is applied synchronously, in the same
   * event as the click, so a controlled checkbox or field never flips back.
   */
  const mutate = (edit: Edit) => {
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
    mutation.mutate({ edit, rollback });
  };

  return { mutate, isPending: mutation.isPending };
}
