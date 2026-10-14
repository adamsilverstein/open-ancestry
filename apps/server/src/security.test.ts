import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from './index';
import {
  createToken,
  isLoopbackHost,
  isSameOrigin,
  parseHostHeader,
  pathProblem,
  SECURITY_HEADERS,
} from './security';
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
// One server for the file: these tests only read, or create uniquely named trees.
beforeAll(async () => {
  api = await testApi();
});
afterAll(() => api.close());

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
    'localhost.:4317',
    'user@localhost:4317',
    '127.0.0.1:4317, evil.example',
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
      payload: { name: 'Accepted 1' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('accepts an origin without the default port', async () => {
    const res = await api.inject({
      method: 'POST',
      url: '/api/trees',
      headers: { host: 'localhost', origin: 'http://localhost', 'x-oa-token': TOKEN },
      payload: { name: 'Accepted 2' },
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
    [
      'an Origin with userinfo',
      { host: HOST, origin: 'http://evil@127.0.0.1:4317', 'x-oa-token': TOKEN },
    ],
    ['an Origin with a path', { host: HOST, origin: `${ORIGIN}/`, 'x-oa-token': TOKEN }],
    [
      'an Origin with a trailing dot',
      { host: HOST, origin: 'http://127.0.0.1.:4317', 'x-oa-token': TOKEN },
    ],
    [
      'an uppercase Origin',
      { host: 'localhost:4317', origin: 'http://LOCALHOST:4317', 'x-oa-token': TOKEN },
    ],
    [
      'an Origin prefix match',
      { host: HOST, origin: 'http://127.0.0.1:4317.evil.example', 'x-oa-token': TOKEN },
    ],
    [
      'a look-alike Origin',
      { host: HOST, origin: 'http://localhost.evil.example:4317', 'x-oa-token': TOKEN },
    ],
    ['two Origins', { host: HOST, origin: `${ORIGIN}, http://evil.example`, 'x-oa-token': TOKEN }],
    [
      'an explicit default port mismatch',
      { host: '127.0.0.1', origin: 'http://127.0.0.1:8080', 'x-oa-token': TOKEN },
    ],
    ['no token', { host: HOST, origin: ORIGIN }],
    ['a wrong token', { host: HOST, origin: ORIGIN, 'x-oa-token': 'nope' }],
    [
      'a same-length wrong token',
      { host: HOST, origin: ORIGIN, 'x-oa-token': TOKEN.replace('0', 'x') },
    ],
  ])('rejects a mutation with %s', async (_, headers) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await api.inject({
        method,
        url: '/api/trees/Accepted%201',
        headers,
        payload: { name: 'Rejected' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    }
    const trees = (await api.get('/api/trees')).json().trees.map((t: { id: string }) => t.id);
    expect(trees).not.toContain('Rejected');
  });

  it('rejects duplicate Origin and token headers', async () => {
    const res = await api.inject({
      method: 'POST',
      url: '/api/trees',
      headers: {
        host: HOST,
        origin: [ORIGIN, 'http://evil.example'],
        'x-oa-token': [TOKEN, TOKEN],
      } as unknown as Record<string, string>,
      payload: { name: 'A' },
    });
    expect(res.statusCode).toBe(403);
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

describe('paths the router would decode', () => {
  it.each([
    ['POST', '/%61pi/trees'],
    ['POST', '/ap%69/trees'],
    ['POST', '/%41PI/trees'],
    ['DELETE', '/%61pi/trees/Accepted%201'],
    ['POST', '/api/trees/Accepted%201/%75ndo'],
    ['POST', '/api/trees%2fAccepted%201/undo'],
    ['POST', '/%2561pi/trees'],
    ['POST', '/api//trees'],
    ['GET', '/%61pi/session'],
  ])('refuses %s %s before routing', async (method, url) => {
    const res = await api.inject({
      method: method as 'POST',
      url,
      headers: { host: HOST },
      payload: { name: 'Sneaky' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
    expectSecurityHeaders(res.headers);
  });

  it.each(['/API/trees', '/Api/trees', '/api/trees/', '/apifoo', '/', '/anything/else'])(
    'requires the token for a mutation to %s whatever the path',
    async (url) => {
      const res = await api.inject({
        method: 'POST',
        url,
        headers: { host: HOST },
        payload: { name: 'Sneaky' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    },
  );

  it('still serves legitimately encoded names', async () => {
    expect((await api.get('/api/trees/Accepted%201')).statusCode).toBe(200);
    expect((await api.get('/api/trees/M%C3%BCller')).statusCode).toBe(404);
  });

  it('pathProblem', () => {
    expect(pathProblem('/api/trees/Vale%20Family?q=%61')).toBeNull();
    expect(pathProblem('/api/trees/')).toBeNull();
    expect(pathProblem('/')).toBeNull();
    expect(pathProblem('/a%7e')).not.toBeNull();
    expect(pathProblem('/a%5Cb')).not.toBeNull();
    expect(pathProblem('/a%2')).not.toBeNull();
    expect(pathProblem('/a%zz')).not.toBeNull();
    expect(pathProblem('/a/./b')).not.toBeNull();
    expect(pathProblem('/a/..')).not.toBeNull();
    // Light-my-request normalizes these before the server sees them; e2e sends them raw.
    expect(pathProblem('/api/%2e%2e/api/trees')).not.toBeNull();
    expect(pathProblem('/api/../api/trees')).not.toBeNull();
  });
});

describe('cross-site navigation', () => {
  it('lets a cross-site link open the app but refuses cross-site fetches and forms', async () => {
    const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };
    expect((await api.get('/', nav)).statusCode).not.toBe(403);
    expect(
      (await api.get('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })).statusCode,
    ).toBe(403);
    const form = await api.inject({
      method: 'POST',
      url: '/api/trees',
      headers: { ...MUTATION_HEADERS, ...nav },
      payload: { name: 'Form' },
    });
    expect(form.statusCode).toBe(403);
  });

  it('refuses cross-site navigations to the API, so another site cannot start a download', async () => {
    const base = await createTestTree(api, 'Cross-site export');
    for (const format of ['json', 'ged', 'gdz']) {
      for (const site of ['cross-site', 'same-site']) {
        const res = await api.get(`${base}/export.${format}`, {
          'sec-fetch-site': site,
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        });
        expect(res.statusCode, `${format} ${site}`).toBe(403);
        expect(res.headers['content-disposition']).toBeUndefined();
      }
    }
    expect(
      (
        await api.get('/api/session', {
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('serves the API to same-origin requests, typed URLs and non-browser clients', async () => {
    const base = await createTestTree(api, 'Same-origin export');
    for (const headers of [
      { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
      { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
      { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
      {},
    ]) {
      expect((await api.get(`${base}/export.json`, headers)).statusCode).toBe(200);
    }
  });
});

describe('framework errors', () => {
  it('carry the security headers and the error envelope', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/api/trees/%E0%A4%A',
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(400);
    expectSecurityHeaders(res.headers);
    const bad = await api.inject({
      method: 'POST',
      url: '/api/trees',
      headers: { ...MUTATION_HEADERS, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('bad_request');
    expectSecurityHeaders(bad.headers);
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

  it('isSameOrigin compares exact serialized origins', () => {
    const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
    expect(isSameOrigin('http://[::1]:4317', '[::1]:4317', allowed)).toBe(true);
    expect(isSameOrigin('http://localhost', 'localhost:80', allowed)).toBe(true);
    expect(isSameOrigin('http://evil.example', 'evil.example', allowed)).toBe(false);
    expect(isSameOrigin(['http://localhost'], 'localhost', allowed)).toBe(false);
    expect(isSameOrigin('http://localhost', undefined, allowed)).toBe(false);
  });

  it('parseHostHeader', () => {
    expect(parseHostHeader('localhost.')?.hostname).toBe('localhost.');
    expect(parseHostHeader('user@localhost')).toBeNull();
    expect(parseHostHeader('localhost:99999')).toBeNull();
    expect(parseHostHeader('localhost:0')).toBeNull();
    expect(parseHostHeader('localhost:65535')?.port).toBe('65535');
    expect(parseHostHeader('LocalHost:80')).toEqual({ hostname: 'localhost', port: '80' });
    expect(parseHostHeader('[::1]')).toEqual({ hostname: '[::1]', port: '' });
    expect(parseHostHeader('a b')).toBeNull();
    expect(parseHostHeader('localhost:')).toBeNull();
  });
});
