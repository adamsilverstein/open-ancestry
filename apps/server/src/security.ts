import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
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
  if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return null;
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

/** The API, as the router will see it (pathProblem refuses encoded letters first). */
const API_PATH = /^\/api(?:[/?]|$)/;

function reject(
  reply: FastifyReply,
  status: number,
  code: 'forbidden' | 'forbidden_host' | 'bad_request',
  message: string,
) {
  return reply.code(status).send(errorBody(code, message));
}

/**
 * The Origin header must be exactly the origin a browser serializes for this
 * server: `http://` + the (already allowlisted) Host header, nothing else. The
 * raw string is compared to its own normalized serialization, so userinfo,
 * paths, uppercase, trailing dots, `null`, duplicates joined by Node and other
 * parser-differential tricks are all refused rather than normalized away.
 */
export function isSameOrigin(
  origin: string | string[] | undefined,
  host: string | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  let parsed: URL;
  let self: URL;
  try {
    parsed = new URL(origin);
    self = new URL(`http://${host}`);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'http:' &&
    origin === parsed.origin &&
    allowed.has(parsed.hostname) &&
    parsed.origin === self.origin
  );
}

/** Bytes that must never arrive percent-encoded in a path: unreserved characters, `/`, `\\` and `%`. */
const NEEDLESS_ESCAPE = /^(?:[A-Za-z0-9._~/\\%-])$/;

/**
 * Why a request path is refused, or null. The router decodes paths before
 * matching, so anything whose meaning could change on decoding (encoded
 * letters, dots, slashes, double encoding) or dot and empty segments is
 * rejected outright instead of being normalized.
 */
export function pathProblem(url: string): string | null {
  const path = url.split('?', 1)[0]!;
  for (const match of path.matchAll(/%(.{0,2})/g)) {
    if (!/^[0-9a-fA-F]{2}$/.test(match[1]!)) return 'Malformed percent-encoding in path';
    if (NEEDLESS_ESCAPE.test(String.fromCharCode(parseInt(match[1]!, 16))))
      return 'Path contains an encoded character that must be sent literally';
  }
  const segments = path.split('/').slice(1);
  if (segments.slice(0, -1).some((segment) => segment === ''))
    return 'Path contains an empty segment';
  if (segments.some((segment) => segment === '.' || segment === '..'))
    return 'Path contains a dot segment';
  return null;
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

    const problem = pathProblem(request.url);
    if (problem) return reject(reply, 400, 'bad_request', problem);

    // Browsers label requests a cross-site page makes. Only a top-level
    // navigation to the app (a link to it) is legitimate; fetches and forms
    // are not, and neither is navigating to the API: that would let any site
    // drop an export into the Downloads folder. The app calls its API
    // same-origin; typed URLs say `none`; other clients send no label.
    const safe = SAFE_METHODS.has(request.method);
    const site = request.headers['sec-fetch-site'];
    if (
      (site === 'cross-site' && (!safe || request.headers['sec-fetch-mode'] !== 'navigate')) ||
      (site !== undefined &&
        site !== 'same-origin' &&
        site !== 'none' &&
        API_PATH.test(request.url))
    ) {
      return reject(reply, 403, 'forbidden', 'Cross-site requests are not allowed');
    }
    if (safe) return;
    // Every other method is a mutation, whatever the path: gating on the raw
    // URL would let `/%61pi/...` reach API routes after the router decodes it.
    if (!isSameOrigin(request.headers.origin, request.headers.host, allowed)) {
      return reject(reply, 403, 'forbidden', 'Missing or cross-origin Origin header');
    }
    if (!sameToken(request.headers[TOKEN_HEADER], options.token)) {
      return reject(reply, 403, 'forbidden', `Missing or invalid ${TOKEN_HEADER} header`);
    }
  });

  // Responses Fastify builds itself (e.g. a 400 for a malformed URL) skip
  // onRequest, so make sure every response carries the headers.
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    return payload;
  });

  app.get('/api/session', async () => ({ token: options.token, tokenHeader: TOKEN_HEADER }));
}
