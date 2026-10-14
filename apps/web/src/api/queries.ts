import { queryOptions } from '@tanstack/react-query';
import { apiGet, seg } from './client';
import type { Neighborhood, PersonDetail } from './types';

export interface TreeListItem {
  id: string;
  name: string;
  modifiedAt: string;
}

export interface TreeInfo extends TreeListItem {
  peopleCount: number;
  /** People a privatized export hides because they are (or may be) living. */
  livingCount: number;
  /** Other people a privatized export hides: marked private or confidential. */
  privateCount: number;
  homePersonId: string | null;
  schemaVersion: number;
}

/** localStorage key of the tree the user last opened. */
export const CURRENT_TREE_KEY = 'oa-tree';

function storedTree(): string | null {
  try {
    return localStorage.getItem(CURRENT_TREE_KEY);
  } catch {
    return null;
  }
}

/**
 * The open tree: the last one used if it still exists, else the first in the
 * library, else null (an empty library).
 */
export const currentTreeQuery = queryOptions({
  queryKey: ['current-tree'],
  queryFn: async ({ signal }) => {
    const { trees } = await apiGet<{ trees: TreeListItem[] }>('/trees', signal);
    const stored = storedTree();
    return (trees.find((t) => t.id === stored) ?? trees[0])?.id ?? null;
  },
  staleTime: Infinity,
});

export const treeQuery = (tree: string) =>
  queryOptions({
    queryKey: ['tree', tree],
    queryFn: async ({ signal }) =>
      (await apiGet<{ tree: TreeInfo }>(`/trees/${seg(tree)}`, signal)).tree,
  });

export const personQuery = (tree: string, id: string) =>
  queryOptions({
    queryKey: ['person', tree, id],
    queryFn: ({ signal }) => apiGet<PersonDetail>(`/trees/${seg(tree)}/people/${seg(id)}`, signal),
  });

/** Every recorded ancestor (up to the API's 10 generations), for relationship naming. */
export const ancestorsQuery = (tree: string, id: string) =>
  queryOptions({
    queryKey: ['ancestors', tree, id],
    queryFn: ({ signal }) =>
      apiGet<Neighborhood>(
        `/trees/${seg(tree)}/neighborhood?focus=${seg(id)}&up=10&down=0&siblings=false`,
        signal,
      ),
  });

export const mediaUrl = (tree: string, mediaId: string) =>
  `/api/trees/${seg(tree)}/media/${seg(mediaId)}`;
