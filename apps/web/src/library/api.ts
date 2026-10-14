/**
 * Library (trees) and import calls to the server (docs/api.md). Mutations
 * carry the per-process token from `/api/session`; the browser adds Origin.
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiSend, seg } from '../api/client';
import {
  CURRENT_TREE_KEY,
  currentTreeQuery,
  type TreeInfo,
  type TreeListItem,
} from '../api/queries';

export { ApiError, currentTreeQuery, type TreeListItem };

const tree = (id: string) => `/trees/${seg(id)}`;

export const listTrees = (signal?: AbortSignal) =>
  apiGet<{ trees: TreeListItem[] }>('/trees', signal).then((r) => r.trees);
export const createTree = (name: string) =>
  apiSend<{ tree: TreeInfo }>('POST', '/trees', { name }).then((r) => r.tree);
export const renameTree = (id: string, name: string) =>
  apiSend<{ tree: TreeInfo }>('PATCH', tree(id), { name }).then((r) => r.tree);
export const deleteTree = (id: string) => apiSend<void>('DELETE', tree(id));
export const getTree = (id: string, signal?: AbortSignal) =>
  apiGet<{ tree: TreeInfo }>(tree(id), signal).then((r) => r.tree);

export const getJob = (id: string, signal?: AbortSignal) =>
  apiGet<ImportJob>(`/jobs/${seg(id)}`, signal);

export const jobEventsUrl = (id: string) => `/api/jobs/${seg(id)}/events`;

/** The import report (packages/import ImportReport), as much as the UI shows. */
export interface ImportReportView {
  format: string;
  encoding: string;
  file: { name: string | null; bytes: number };
  source: { system: string | null; version: string | null; gedcomVersion: string | null };
  records: Record<string, number>;
  rows: Record<string, number | undefined>;
  warnings: { code: string; line: number; message: string }[];
  warningCount: number;
  unmapped: { path: string; tag: string; count: number; example: { line: number; text: string } }[];
  lines: { total: number; mapped: number; preserved: number };
  media: {
    linked: number;
    remote: number;
    missing: { path: string; line: number }[];
    rejected: number;
  };
  living: { living: number; deceased: number };
  homePersonId: string | null;
  timings: { total: number };
}

export interface ImportProgress {
  phase: 'read' | 'parse' | 'map' | 'finalize' | 'commit' | 'done';
  done: number;
  total: number;
}

export interface ImportJob {
  id: string;
  tree: string;
  fileName: string;
  /** The server created the tree for this upload (and removed it if the import failed). */
  createdTree: boolean;
  state: 'queued' | 'running' | 'completed' | 'failed';
  progress: ImportProgress | null;
  result: ImportReportView | null;
  error: string | null;
}

// ---------------------------------------------------------------- current tree

export const treesQuery = queryOptions({
  queryKey: ['trees'],
  queryFn: ({ signal }) => listTrees(signal),
});

/** Makes `id` the open tree (or none) and refreshes everything that depends on it. */
export async function setCurrentTree(queryClient: QueryClient, id: string | null): Promise<void> {
  try {
    if (id) localStorage.setItem(CURRENT_TREE_KEY, id);
    else localStorage.removeItem(CURRENT_TREE_KEY);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  queryClient.setQueryData(currentTreeQuery.queryKey, id);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: treesQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: ['tree'] }),
  ]);
}

// ---------------------------------------------------------------- import flow

export const IMPORT_EXTENSIONS = ['.ged', '.gedcom', '.zip', '.gdz'];
export const IMPORT_ACCEPT = IMPORT_EXTENSIONS.join(',');
export const BAD_FILE_MESSAGE = 'Choose a .ged, .gedcom, .zip or .gdz file';

export function hasImportExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Uploads the file into a new tree the server creates, named after the file
 * (" 2", " 3", ... when taken). The server owns that tree: if the import
 * fails it removes it, so the client never deletes anything.
 */
export async function importIntoNewTree(file: File): Promise<{ jobId: string; tree: string }> {
  const form = new FormData();
  form.append('file', file, file.name);
  const { jobId, job } = await apiSend<{ jobId: string; job: ImportJob }>('POST', '/import', form);
  return { jobId, tree: job.tree };
}
