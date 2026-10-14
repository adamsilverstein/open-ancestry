/** The tree view's server endpoints (docs/api.md), on the shared API client. */
import { apiGet, seg } from '../api/client';
import type { ApiPersonSummary, EventBrief, Neighborhood } from '../api/types';

export { ApiError } from '../api/client';
export type { ApiPersonSummary };
export type ApiEventBrief = EventBrief;
export type ApiNeighborhood = Neighborhood;

export interface NeighborhoodRequest {
  focus: string;
  up: number;
  down: number;
  siblings?: boolean;
}

export const treePath = (tree: string) => `/api/trees/${seg(tree)}`;

export const fetchHome = (tree: string, signal?: AbortSignal) =>
  apiGet<{ personId: string | null }>(`/trees/${seg(tree)}/home`, signal).then((r) => r.personId);

export function fetchNeighborhood(
  tree: string,
  { focus, up, down, siblings = true }: NeighborhoodRequest,
  signal?: AbortSignal,
): Promise<ApiNeighborhood> {
  const query = new URLSearchParams({
    focus,
    up: String(up),
    down: String(down),
    siblings: String(siblings),
  });
  return apiGet(`/trees/${seg(tree)}/neighborhood?${query}`, signal);
}

export const searchPeople = (tree: string, q: string, signal?: AbortSignal) =>
  apiGet<{ items: { person: ApiPersonSummary; score: number }[] }>(
    `/trees/${seg(tree)}/search?${new URLSearchParams({ q, limit: '20' })}`,
    signal,
  ).then((r) => r.items.map((item) => item.person));

/** TanStack Query keys, shared by the view and its prefetching. */
export const treeKeys = {
  home: (tree: string) => ['tree', tree, 'home'] as const,
  neighborhood: (tree: string, r: NeighborhoodRequest) =>
    ['tree', tree, 'neighborhood', r.focus, r.up, r.down, r.siblings ?? true] as const,
  search: (tree: string, q: string) => ['tree', tree, 'search', q] as const,
};
