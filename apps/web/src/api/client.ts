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

async function errorFrom(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  return new ApiError(
    response.status,
    body?.error?.code ?? 'http_error',
    body?.error?.message ?? response.statusText,
  );
}

/** GET `/api<path>` as JSON. Reads need no token. */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as T;
}

let session: Promise<{ token: string; tokenHeader: string }> | undefined;

/** The per-process mutation token (`GET /api/session`), fetched once. */
function sessionToken() {
  session ??= apiGet<{ token: string; tokenHeader: string }>('/session').catch((error: unknown) => {
    session = undefined;
    throw error;
  });
  return session;
}

/**
 * A mutation (`POST`, `PATCH`, `DELETE`, ...) with the session token; the
 * browser adds `Origin`. `body` is sent as JSON, or as-is for FormData.
 * Resolves to the JSON response, or undefined for 204.
 */
export async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  let payload: BodyInit | undefined;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const send = async () => {
    const { token, tokenHeader } = await sessionToken();
    return fetch(`/api${path}`, {
      method,
      headers: { ...headers, [tokenHeader]: token },
      body: payload,
    });
  };
  let response = await send();
  if (response.status === 403) {
    // The server restarted and issued a new token: fetch it once and retry.
    session = undefined;
    response = await send();
  }
  if (!response.ok) throw await errorFrom(response);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** Encodes one path segment (tree ids are folder names). */
export const seg = (value: string) => encodeURIComponent(value);
