/**
 * Library (trees) and import calls to the server (docs/api.md). Mutations
 * carry the per-process token from `/api/session`; the browser adds Origin.
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface TreeListItem {
  id: string;
  name: string;
  modifiedAt: string;
}

let session: Promise<{ token: string; tokenHeader: string }> | undefined;

function sessionToken() {
  session ??= request<{ token: string; tokenHeader: string }>('GET', '/session').catch(
    (error: unknown) => {
      session = undefined;
      throw error;
    },
  );
  return session;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (method !== 'GET') {
    const { token, tokenHeader } = await sessionToken();
    headers[tokenHeader] = token;
  }
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`/api${path}`, { method, headers, body: payload, signal });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      response.status,
      error?.error?.code ?? 'http_error',
      error?.error?.message ?? response.statusText,
    );
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const tree = (id: string) => `/trees/${encodeURIComponent(id)}`;

export const listTrees = (signal?: AbortSignal) =>
  request<{ trees: TreeListItem[] }>('GET', '/trees', undefined, signal).then((r) => r.trees);
export const createTree = (name: string) =>
  request<{ tree: TreeListItem }>('POST', '/trees', { name }).then((r) => r.tree);
export const renameTree = (id: string, name: string) =>
  request<{ tree: TreeListItem }>('PATCH', tree(id), { name }).then((r) => r.tree);
export const deleteTree = (id: string) => request<void>('DELETE', tree(id));
export const getTree = (id: string, signal?: AbortSignal) =>
  request<{ tree: TreeListItem & { homePersonId: string | null; peopleCount: number } }>(
    'GET',
    tree(id),
    undefined,
    signal,
  ).then((r) => r.tree);

export function startImport(treeId: string, file: File): Promise<{ jobId: string }> {
  const form = new FormData();
  form.append('file', file, file.name);
  return request('POST', `${tree(treeId)}/import`, form);
}

export const getJob = (id: string, signal?: AbortSignal) =>
  request<ImportJob>('GET', `/jobs/${encodeURIComponent(id)}`, undefined, signal);

export const jobEventsUrl = (id: string) => `/api/jobs/${encodeURIComponent(id)}/events`;

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
  state: 'queued' | 'running' | 'completed' | 'failed';
  progress: ImportProgress | null;
  result: ImportReportView | null;
  error: string | null;
}

// ---------------------------------------------------------------- current tree

/** localStorage key of the tree the user last opened (shared with the person and tree views). */
export const CURRENT_TREE_KEY = 'oa-tree';

function storedTree(): string | null {
  try {
    return localStorage.getItem(CURRENT_TREE_KEY);
  } catch {
    return null;
  }
}

export const treesQuery = queryOptions({
  queryKey: ['trees'],
  queryFn: ({ signal }) => listTrees(signal),
});

/** The open tree: the last one chosen if it still exists, else the first, else null. */
export const currentTreeQuery = queryOptions({
  queryKey: ['current-tree'],
  queryFn: async ({ signal }) => {
    const trees = await listTrees(signal);
    const stored = storedTree();
    return (trees.find((t) => t.id === stored) ?? trees[0])?.id ?? null;
  },
  staleTime: Infinity,
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
  await queryClient.invalidateQueries({ queryKey: treesQuery.queryKey });
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
 * A tree name from a file name: the base name with characters the library
 * refuses (separators, reserved characters, `%`, leading and trailing dots)
 * replaced, trimmed to 90 characters so a numeric suffix still fits.
 */
export function treeNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/, '');
  const name = base
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|%\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 90)
    .trim();
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) || !name ? `Imported ${name}`.trim() : name;
}

/**
 * Creates a tree named after the file (adding " 2", " 3", ... if taken) and
 * uploads the file into it. Returns the job to watch. A failed upload removes
 * the tree it created.
 */
export async function importIntoNewTree(file: File): Promise<{ jobId: string; tree: string }> {
  const base = treeNameFromFile(file.name);
  let created: TreeListItem | undefined;
  for (let n = 1; !created; n++) {
    try {
      created = await createTree(n === 1 ? base : `${base} ${n}`);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409) || n >= 50) throw error;
    }
  }
  try {
    const { jobId } = await startImport(created.id, file);
    return { jobId, tree: created.id };
  } catch (error) {
    await deleteTree(created.id).catch(() => {});
    throw error;
  }
}
