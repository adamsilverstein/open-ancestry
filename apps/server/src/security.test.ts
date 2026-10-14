import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from './index';
import { createToken, isLoopbackHost, parseHostHeader, SECURITY_HEADERS } from './security';
import {
  HOST,
  MUTATION_HEADERS,
  ORIGIN,
  TOKEN,
  createTestTree,
  testApi,
  type TestApi,
} from './test/helpers';

let api: TestApi;
beforeEach(async () => {
  api = await testApi();
});
afterEach(() => api.close());

function expectSecurityHeaders(headers: Record<string, unknown>) {
  const csp = String(headers['content-security-policy']);
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("img-src 'self' data: blob:");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['access-control-allow-origin']).toBeUndefined();
}

describe('security headers', () => {
  it('are sent on API, 404, error and rejected responses', async () => {
    expectSecurityHeaders((await api.get('/api/health')).headers);
    expectSecurityHeaders((await api.get('/api/nope')).headers);
    expectSecurityHeaders((await api.get('/api/trees/Missing')).headers);
    expectSecurityHeaders((await api.get('/api/health', { host: 'evil.example' })).headers);
    expectSecurityHeaders(
      (await api.inject({ method: 'POST', url: '/api/trees', headers: { host: HOST } })).headers,
    );
  });

  it('are sent on the SPA shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-static-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
    const app = createServer({ staticDir: dir, library: api.root });
    const res = await app.inject({ method: 'GET', url: '/tree/x', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expectSecurityHeaders(res.headers);
    await app.close();
  });

  it('match the exported policy', () => {
    expect(SECURITY_HEADERS['x-frame-options']).toBe('DENY');
  });
});

describe('Host allowlist (DNS rebinding)', () => {
  it.each(['localhost', 'localhost:4317', '127.0.0.1:4317', '[::1]:4317', 'LOCALHOST:1'])(
    'accepts %s',
    async (host) => {
      expect((await api.get('/api/health', { host })).statusCode).toBe(200);
    },
  );

  it.each([
    'evil.example',
    'evil.example:4317',
    '127.0.0.1.evil.example',
    'localhost.evil.example:4317',
    '10.0.0.5:4317',
    'local host',
    '[::2]:4317',
  ])('rejects %j', async (host) => {
    const res = await api.get('/api/health', { host });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: 'forbidden_host', message: 'Host not allowed' } });
  });

  it('applies to the SPA too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-static-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
    const app = createServer({ staticDir: dir, library: api.root });
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('spa');
    await app.close();
  });

  it('accepts explicitly allowed hosts', async () => {
    const app = createServer({ library: api.root, allowedHosts: ['192.168.1.20'] });
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '192.168.1.20:4317' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('session token and mutation guard', () => {
  it('issues the per-process token', async () => {
    const res = await api.get('/api/session');
    expect(res.json()).toEqual({ token: TOKEN, tokenHeader: 'x-oa-token' });
  });

  it('generates a different random token per process', async () => {
    const a = createToken();
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(createToken()).not.toBe(a);
    const app = createServer({ library: api.root });
    const res = await app.inject({ method: 'GET', url: '/api/session', headers: { host: HOST } });
    expect(res.json().token).not.toBe(TOKEN);
    await app.close();
  });

  it('accepts a same-origin mutation with the token', async () => {
    const res = await api.inject({
      method: 'POST',
      url: '/api/trees',
      headers: MUTATION_HEADERS,
      payload: { name: 'A' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('accepts an origin without the default port', async () => {
    const res = await api.inject({
      method: 'POST',
      url: '/api/trees',
      headers: { host: 'localhost', origin: 'http://localhost', 'x-oa-token': TOKEN },
      payload: { name: 'A' },
    });
    expect(res.statusCode).toBe(201);
  });

  it.each([
    ['no Origin', { host: HOST, 'x-oa-token': TOKEN }],
    ['a cross-origin Origin', { host: HOST, origin: 'http://evil.example', 'x-oa-token': TOKEN }],
    ['another port', { host: HOST, origin: 'http://127.0.0.1:9999', 'x-oa-token': TOKEN }],
    ['https', { host: HOST, origin: 'https://127.0.0.1:4317', 'x-oa-token': TOKEN }],
    ['a null Origin', { host: HOST, origin: 'null', 'x-oa-token': TOKEN }],
    ['a malformed Origin', { host: HOST, origin: 'http://[bad', 'x-oa-token': TOKEN }],
    ['no token', { host: HOST, origin: ORIGIN }],
    ['a wrong token', { host: HOST, origin: ORIGIN, 'x-oa-token': 'nope' }],
    [
      'a same-length wrong token',
      { host: HOST, origin: ORIGIN, 'x-oa-token': TOKEN.replace('0', 'x') },
    ],
  ])('rejects a mutation with %s', async (_, headers) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await api.inject({ method, url: '/api/trees', headers, payload: { name: 'A' } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    }
    expect((await api.get('/api/trees')).json().trees).toEqual([]);
  });

  it('lets reads through without a token', async () => {
    expect((await api.get('/api/trees')).statusCode).toBe(200);
  });

  it('rejects requests a browser labels cross-site, even reads', async () => {
    const res = await api.get('/api/session', { 'sec-fetch-site': 'cross-site' });
    expect(res.statusCode).toBe(403);
    expect((await api.get('/api/session', { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(
      200,
    );
  });
});

describe('no CORS', () => {
  it('never sends CORS headers, even to a preflight', async () => {
    const preflight = await api.inject({
      method: 'OPTIONS',
      url: '/api/trees',
      headers: {
        host: HOST,
        origin: 'http://evil.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-methods']).toBeUndefined();
    const read = await api.get('/api/session', { origin: 'http://evil.example' });
    expect(read.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('body limits', () => {
  it('refuses JSON bodies over 1 MiB', async () => {
    const base = await createTestTree(api);
    const res = await api.post(`${base}/people`, { names: [{ given: 'x'.repeat(1024 * 1024) }] });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
  });
});

describe('helpers', () => {
  it('isLoopbackHost', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]'])
      expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.2', 'example.com'])
      expect(isLoopbackHost(h)).toBe(false);
  });

  it('parseHostHeader', () => {
    expect(parseHostHeader('LocalHost:80')).toEqual({ hostname: 'localhost', port: '80' });
    expect(parseHostHeader('[::1]')).toEqual({ hostname: '[::1]', port: '' });
    expect(parseHostHeader('a b')).toBeNull();
    expect(parseHostHeader('localhost:')).toBeNull();
  });
});
