/**
 * Client for the tree view's server endpoints (docs/api.md). Response types
 * mirror the `packages/db` DTOs structurally; the web app depends on core only.
 */
import type { ChildRelation, PartnerRelationship, Sex } from '@open-ancestry/core';

export interface ApiEventBrief {
  eventId: string;
  type: string;
  dateText: string | null;
  dateQualifier: string | null;
  dateSort: number | null;
  place: string | null;
}

export interface ApiPersonSummary {
  id: string;
  sex: Sex;
  living: string;
  privacy: string;
  primaryMediaId: string | null;
  given: string | null;
  surname: string | null;
  surnamePrefix: string | null;
  prefix: string | null;
  suffix: string | null;
  nickname: string | null;
  birth: ApiEventBrief | null;
  death: ApiEventBrief | null;
}

export interface ApiNeighborhood {
  focusId: string;
  people: ApiPersonSummary[];
  families: {
    id: string;
    partner1Id: string | null;
    partner2Id: string | null;
    relationshipType: PartnerRelationship;
    partner1Order: number;
    partner2Order: number;
  }[];
  children: {
    familyId: string;
    childId: string;
    partner1Rel: ChildRelation;
    partner2Rel: ChildRelation;
    sortOrder: number;
    childOrder: number;
    isPreferred: boolean;
  }[];
  moreUp: string[];
  moreDown: string[];
  truncated: boolean;
}

export interface ApiTree {
  id: string;
  name: string;
  modifiedAt: string;
}

export interface NeighborhoodRequest {
  focus: string;
  up: number;
  down: number;
  siblings?: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code: string; message: string };
    } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'http_error',
      body?.error?.message ?? response.statusText,
    );
  }
  return (await response.json()) as T;
}

export const treePath = (tree: string) => `/api/trees/${encodeURIComponent(tree)}`;

export const fetchTrees = (signal?: AbortSignal) =>
  get<{ trees: ApiTree[] }>('/api/trees', signal).then((r) => r.trees);

export const fetchHome = (tree: string, signal?: AbortSignal) =>
  get<{ personId: string | null }>(`${treePath(tree)}/home`, signal).then((r) => r.personId);

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
  return get(`${treePath(tree)}/neighborhood?${query}`, signal);
}

export const searchPeople = (tree: string, q: string, signal?: AbortSignal) =>
  get<{ items: { person: ApiPersonSummary; score: number }[] }>(
    `${treePath(tree)}/search?${new URLSearchParams({ q, limit: '20' })}`,
    signal,
  ).then((r) => r.items.map((item) => item.person));

/** TanStack Query keys, shared by the view and its prefetching. */
export const treeKeys = {
  trees: ['trees'] as const,
  home: (tree: string) => ['tree', tree, 'home'] as const,
  neighborhood: (tree: string, r: NeighborhoodRequest) =>
    ['tree', tree, 'neighborhood', r.focus, r.up, r.down, r.siblings ?? true] as const,
  search: (tree: string, q: string) => ['tree', tree, 'search', q] as const,
};
