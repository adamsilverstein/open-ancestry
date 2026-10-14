import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errorBody } from './errors';

/*
 * The server holds private family data and listens on loopback, so the threats
 * are other websites in the user's browser:
 * - DNS rebinding: a page on evil.example re-points its name at 127.0.0.1 and
 *   reads the API "same-origin". Refused by the Host allowlist.
 * - CSRF: a page posts to the API. Mutations need a same-origin Origin header
 *   and the per-process token, which a cross-origin page cannot read (no CORS).
 */

export const TOKEN_HEADER = 'x-oa-token';

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for localhost, 127.0.0.1 and ::1 (bracketed or not). */
export function isLoopbackHost(host: string): boolean {
  const bracketed = !host.startsWith('[') && host.includes(':') ? `[${host}]` : host;
  return LOOPBACK_NAMES.has(bracketed.toLowerCase());
}

/** Splits a Host header into its hostname (IPv6 bracketed) and port; null if malformed. */
export function parseHostHeader(value: string): { hostname: string; port: string } | null {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(value);
  if (!match) return null;
  return { hostname: match[1]!.toLowerCase(), port: match[2] ?? '' };
}

export interface SecurityOptions {
  token: string;
  /** Extra hostnames accepted in the Host header (an explicit non-loopback --host). */
  allowedHosts?: readonly string[];
}

export function createToken(): string {
  return randomBytes(32).toString('base64url');
}

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function reject(
  reply: FastifyReply,
  status: number,
  code: 'forbidden' | 'forbidden_host',
  message: string,
) {
  return reply.code(status).send(errorBody(code, message));
}

/** Origin must be exactly this server: http, same host and port as the Host header. */
function isSameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.host === new URL(`http://${host}`).host;
  } catch {
    return false;
  }
}

export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  const allowed = new Set([
    ...LOOPBACK_NAMES,
    ...(options.allowedHosts ?? []).map((h) => h.toLowerCase()),
  ]);

  app.addHook('onRequest', async (request, reply) => {
    reply.headers(SECURITY_HEADERS);

    const host = parseHostHeader(request.headers.host ?? '');
    if (!host || !allowed.has(host.hostname)) {
      return reject(reply, 403, 'forbidden_host', 'Host not allowed');
    }

    const isApi = request.url === '/api' || request.url.startsWith('/api/');
    if (!isApi) return;
    // Browsers label requests a cross-site page makes; nothing legitimate is cross-site.
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reject(reply, 403, 'forbidden', 'Cross-site requests are not allowed');
    }
    if (SAFE_METHODS.has(request.method)) return;
    if (!isSameOrigin(request)) {
      return reject(reply, 403, 'forbidden', 'Missing or cross-origin Origin header');
    }
    if (!sameToken(request.headers[TOKEN_HEADER], options.token)) {
      return reject(reply, 403, 'forbidden', `Missing or invalid ${TOKEN_HEADER} header`);
    }
  });

  app.get('/api/session', async () => ({ token: options.token, tokenHeader: TOKEN_HEADER }));
}
