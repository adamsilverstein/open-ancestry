import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { SearchMatch, TagRow } from '@open-ancestry/db';
import { apiGet, seg } from './client';
import { currentTreeQuery } from './queries';
import type { ApiPersonSummary } from './types';

/*
 * Search and people-list reads (docs/api.md). Kept apart from queries.ts so
 * the palette, the people list and "Find in tree" share one place.
 */

export interface SearchHit {
  person: ApiPersonSummary;
  match: SearchMatch;
  score: number;
}

/** Results shown in the command palette. */
export const PALETTE_RESULTS = 8;

/** Results the palette shows after "Show all N people" (the server's maximum). */
export const PALETTE_ALL_RESULTS = 100;

/** A page of search results, and how many people match in all. */
export interface SearchPage {
  items: SearchHit[];
  total: number;
}

export const searchQuery = (tree: string, q: string, limit = PALETTE_RESULTS) =>
  queryOptions({
    queryKey: ['search', tree, q, limit],
    queryFn: ({ signal }) =>
      apiGet<SearchPage>(
        `/trees/${seg(tree)}/search?q=${encodeURIComponent(q)}&limit=${limit}`,
        signal,
      ),
    staleTime: 60_000,
  });

/** How long newer text waits for an in-flight search before searching anyway. */
export const SEARCH_WAIT_LIMIT_MS = 1000;

const searchable = (q: string) => /[\p{L}\p{N}]/u.test(q);

/**
 * People in the open tree matching `query`. There is no debounce: a key
 * typed while no search is running is searched at once, and keys typed while
 * one is running wait for it, then search the latest text only. So a fast
 * server answers each pause in typing within a few ms (at the cost of about
 * one request per key, each a few ms), and a slow query never queues a
 * request per key behind it. A search that hangs past SEARCH_WAIT_LIMIT_MS
 * stops holding the latest text back.
 *
 * While the current query's results load, the previous results stay
 * available as `stale` (so the list does not flash) and `pending` is true;
 * stale hits must not be treated as answers to the current query.
 */
export function useSearchPeople(query: string, limit = PALETTE_RESULTS) {
  const { data: tree = null } = useQuery(currentTreeQuery);
  const current = query.trim();
  const [requested, setRequested] = useState(current);
  const enabled = tree !== null && searchable(requested);
  const result = useQuery({
    ...searchQuery(tree ?? '', requested, limit),
    enabled,
    placeholderData: keepPreviousData,
  });
  const busy = enabled && result.isFetching;
  // A request that hangs must not hold back newer text for good.
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  const waiting = busy && requested !== current && gaveUp !== requested;
  useEffect(() => {
    if (!waiting) return;
    const id = setTimeout(() => setGaveUp(requested), SEARCH_WAIT_LIMIT_MS);
    return () => clearTimeout(id);
  }, [waiting, requested]);
  if (!waiting && requested !== current) setRequested(current);
  const wanted = tree !== null && searchable(current);
  const fresh =
    wanted && requested === current && result.data !== undefined && !result.isPlaceholderData;
  return {
    tree,
    hits: wanted ? (result.data?.items ?? []) : [],
    /** Everyone who matches, for "Show all N people"; 0 until known. */
    total: wanted ? (result.data?.total ?? 0) : 0,
    stale: wanted && !fresh,
    pending: wanted && !fresh && !result.isError,
  };
}

// ------------------------------------------------------------ people list

export const PEOPLE_SORTS = ['surname', 'given', 'birth', 'death'] as const;
export type PeopleSort = (typeof PEOPLE_SORTS)[number];
export const PEOPLE_SEXES = ['M', 'F', 'X', 'U'] as const;
export type PeopleSex = (typeof PEOPLE_SEXES)[number];
export const PEOPLE_LIVING = ['living', 'deceased'] as const;
export type PeopleLiving = (typeof PEOPLE_LIVING)[number];

export interface PeopleParams {
  sort: PeopleSort;
  dir: 'asc' | 'desc';
  sex?: PeopleSex | undefined;
  living?: PeopleLiving | undefined;
  tag?: string | undefined;
}

/** Unknown counts as living, as everywhere else privacy is concerned. */
const LIVING_STATUSES: Record<PeopleLiving, string> = {
  living: 'living,inferred_living,unknown',
  deceased: 'dead,inferred_dead',
};

/** Rows fetched per request while scrolling. */
export const PEOPLE_PAGE_SIZE = 100;

export function peopleQueryString(params: PeopleParams, page: number): string {
  const q = new URLSearchParams({
    sort: params.sort,
    dir: params.dir,
    limit: String(PEOPLE_PAGE_SIZE),
    offset: String(page * PEOPLE_PAGE_SIZE),
  });
  if (params.sex) q.set('sex', params.sex);
  if (params.living) q.set('living', LIVING_STATUSES[params.living]);
  if (params.tag) q.set('tag', params.tag);
  return q.toString();
}

export const peoplePageQuery = (tree: string, params: PeopleParams, page: number) =>
  queryOptions({
    queryKey: ['people', tree, params, page],
    queryFn: ({ signal }) =>
      apiGet<{ total: number; items: ApiPersonSummary[] }>(
        `/trees/${seg(tree)}/people?${peopleQueryString(params, page)}`,
        signal,
      ),
  });

export const tagsQuery = (tree: string) =>
  queryOptions({
    queryKey: ['tags', tree],
    queryFn: async ({ signal }) =>
      (await apiGet<{ items: (TagRow & { people: number })[] }>(`/trees/${seg(tree)}/tags`, signal))
        .items,
  });
