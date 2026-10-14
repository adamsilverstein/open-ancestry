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
  /** 0 none, 1 the focus person's siblings, 2 also aunts and uncles (and their spouses). */
  siblingsDepth?: number;
}

export const treePath = (tree: string) => `/api/trees/${seg(tree)}`;

export const fetchHome = (tree: string, signal?: AbortSignal) =>
  apiGet<{ personId: string | null }>(`/trees/${seg(tree)}/home`, signal).then((r) => r.personId);

export function fetchNeighborhood(
  tree: string,
  { focus, up, down, siblingsDepth = 1 }: NeighborhoodRequest,
  signal?: AbortSignal,
): Promise<ApiNeighborhood> {
  const query = new URLSearchParams({
    focus,
    up: String(up),
    down: String(down),
    siblingsDepth: String(siblingsDepth),
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
    ['tree', tree, 'neighborhood', r.focus, r.up, r.down, r.siblingsDepth ?? 1] as const,
  search: (tree: string, q: string) => ['tree', tree, 'search', q] as const,
};

/** The server's limit on generations per neighborhood request (db `MAX_NEIGHBORHOOD_GENERATIONS`). */
export const MAX_GENERATIONS = 10;

/** A generation count from the URL, as a whole number from 0 to MAX_GENERATIONS. */
export function clampGenerations(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_GENERATIONS, Math.max(0, Math.round(value)));
}

/**
 * A generation count from a hand-editable URL value, clamped, or undefined when
 * it isn't a number (`abc`, empty) so the caller falls back to its default.
 */
export function parseGenerations(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? clampGenerations(n) : undefined;
}
