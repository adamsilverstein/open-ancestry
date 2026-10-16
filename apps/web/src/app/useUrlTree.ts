import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { CURRENT_TREE_KEY, currentTreeQuery } from '../api/queries';

/**
 * A page whose URL names its tree (`?tree=`) makes that tree the current one
 * (top bar, edits, next visit). It re-syncs on every navigation, not only when
 * the value changes, so Back to a page of another tree switches back to it.
 */
export function useUrlTree(tree: string | undefined): void {
  const queryClient = useQueryClient();
  // The location the router has finished moving to, and the tree it names. While a page
  // is being replaced it can still render once with the next page's location; it only
  // syncs when that location names its own tree.
  const resolved = useRouterState({
    select: (s) => {
      const search = s.resolvedLocation?.search as { tree?: unknown } | undefined;
      return `${typeof search?.tree === 'string' ? search.tree : ''}\u0000${s.resolvedLocation?.href ?? ''}`;
    },
  });
  const synced = useRef<string | null>(null);
  useEffect(() => {
    if (!tree || synced.current === resolved || !resolved.startsWith(`${tree}\u0000`)) return;
    synced.current = resolved;
    if (queryClient.getQueryData(currentTreeQuery.queryKey) === tree) return;
    try {
      localStorage.setItem(CURRENT_TREE_KEY, tree);
    } catch {
      // Storage may be unavailable; the URL still says which tree.
    }
    queryClient.setQueryData(currentTreeQuery.queryKey, tree);
  }, [tree, resolved, queryClient]);
}
