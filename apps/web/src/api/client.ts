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

/** The shape of every record id the server accepts (`Id` in the server schemas). */
export const isValidId = (id: string): boolean => /^[0-9A-Za-z_-]{1,64}$/.test(id);

/**
 * Whether loading person `id` failed because there is no such person: a 404,
 * or an id that cannot exist, which the server refuses with a 400.
 */
export const isMissingPerson = (error: unknown, id: string): boolean =>
  isNotFound(error) || (!isValidId(id) && error instanceof ApiError && error.status === 400);

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
/** How long a JSON write may take before it is given up as hung. */
export const SEND_TIMEOUT_MS = 30_000;

/**
 * Sends a write as JSON (or a FormData upload) and returns the JSON reply.
 * JSON writes time out after SEND_TIMEOUT_MS: edits run one at a time, so a
 * hung request would otherwise hold up every later edit and undo for good.
 * Uploads are left without one, since a large file can take longer.
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
    try {
      return await fetch(`/api${path}`, {
        method,
        headers: { ...headers, [tokenHeader]: token },
        body: payload,
        ...(body instanceof FormData ? {} : { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ApiError(
          0,
          'timeout',
          `The app did not answer within ${SEND_TIMEOUT_MS / 1000} seconds, so this change may not have been saved`,
        );
      }
      throw error;
    }
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
