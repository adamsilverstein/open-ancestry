/** Error body the server sends: `{ error: { code, message } }` (docs/api.md). */
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

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

/** GET `/api<path>` as JSON. Reads need no token; mutations will add `x-oa-token`. */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'http_error',
      body?.error?.message ?? response.statusText,
    );
  }
  return (await response.json()) as T;
}

/** Encodes one path segment (tree ids are folder names). */
export const seg = (value: string) => encodeURIComponent(value);
