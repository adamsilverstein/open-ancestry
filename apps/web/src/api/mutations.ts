import { ApiError, apiGet } from './client';

/*
 * Writes (docs/api.md): every POST, PUT, PATCH and DELETE carries the
 * per-process token from GET /api/session in `x-oa-token`; the browser adds
 * the Origin header itself.
 */

let token: Promise<string> | null = null;

function sessionToken(refresh: boolean): Promise<string> {
  if (refresh || !token) {
    token = apiGet<{ token: string }>('/session').then(
      (session) => session.token,
      (error: unknown) => {
        token = null;
        throw error;
      },
    );
  }
  return token;
}

export type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Sends a mutation and returns its JSON body (`{ batchId, ... }`). */
export async function apiSend<T = { batchId: string | null }>(
  method: WriteMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  const attempt = async (refresh: boolean) =>
    fetch(`/api${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'x-oa-token': await sessionToken(refresh),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  let response = await attempt(false);
  // A restarted server has a new token: fetch it once and retry.
  if (response.status === 403) response = await attempt(true);
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
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}
