import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast/Toast';
import { ApiError } from './client';
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

const FIELD_LABELS: Record<string, string> = {
  given: 'Given names',
  surname: 'Surname',
  surname_prefix: 'Surname prefix',
  prefix: 'Prefix',
  suffix: 'Suffix',
  nickname: 'Nickname',
  date_text: 'Date',
  place: 'Place',
  text: 'Note',
};

/** One field a server validation error names, e.g. `given`, with a plain sentence. */
export interface FieldError {
  field: string;
  message: string;
}

/**
 * Server validation errors read like `body/names/0/given must NOT have more
 * than 200 characters, body/names/0/given must be null`: turn the first one
 * we can name into a plain sentence for the form field it belongs to.
 */
export function fieldError(error: unknown): FieldError | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null;
  const match = /body\/(?:\w+\/)*?(\w+) must NOT have more than (\d+) characters/.exec(
    error.message,
  );
  if (!match) return null;
  const [, field = '', max] = match;
  const label = FIELD_LABELS[field] ?? 'This field';
  return { field, message: `${label} can be at most ${max} characters.` };
}

/** What to tell the user about a failed edit: a plain sentence, never a schema dump. */
export function friendlyMessage(error: unknown): string {
  const field = fieldError(error);
  if (field) return field.message;
  if (error instanceof ApiError && error.status === 400 && error.code === 'validation_failed') {
    return 'Some of the values are not valid.';
  }
  return error instanceof Error ? error.message : String(error);
}

/** Refetches every query of the tree (keys are `[kind, tree, ...]`) and notifies `onTreeChanged`. */
export function invalidateTree(queryClient: QueryClient, tree: string) {
  for (const listener of changeListeners) listener(tree);
  return queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] === tree });
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
      toast({
        title: 'Could not save',
        description: `${edit.label}: ${friendlyMessage(error)}`,
        variant: 'error',
      });
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
