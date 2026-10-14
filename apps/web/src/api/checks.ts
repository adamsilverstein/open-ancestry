import { queryOptions } from '@tanstack/react-query';
import { apiGet, seg } from './client';
import type { ApiPersonSummary } from './types';

/* Tree checker reads (GET /api/trees/:tree/checks). */

export type CheckCategory = 'duplicates' | 'dates' | 'sources';

export interface CheckIssue {
  key: string;
  kind: string;
  category: CheckCategory;
  message: string;
  people: ApiPersonSummary[];
}

export interface CheckReport {
  counts: Record<CheckCategory | 'dismissed', number>;
  items: CheckIssue[];
  dismissed: CheckIssue[];
}

/** Rows the server lists per category (counts are complete). */
export const CHECK_ITEM_LIMIT = 500;

export const checksQuery = (tree: string) =>
  queryOptions({
    queryKey: ['checks', tree],
    queryFn: ({ signal }) => apiGet<CheckReport>(`/trees/${seg(tree)}/checks`, signal),
  });
