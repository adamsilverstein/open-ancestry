import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allowedHostsFor, createServer, startServer, type RunningServer } from './index';

describe('server', () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('answers GET /api/health', async () => {
    const app = createServer();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['server-timing']).toMatch(/^app;dur=\d+\.\d{2}$/);
  });

  it('returns the typed JSON error for unknown API routes', async () => {
    const app = createServer();
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'not_found', message: 'No route for GET /api/nope' },
    });
  });

  it('binds to loopback by default', async () => {
    running = await startServer({ port: 0 });
    expect(new URL(running.url).hostname).toBe('127.0.0.1');
    const res = await fetch(`${running.url}/api/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('brackets IPv6 hosts in the URL', async () => {
    running = await startServer({ host: '::1', port: 0 });
    expect(running.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
  });

  it('serves the SPA with history fallback when given a static dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-static-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
    const app = createServer({ staticDir: dir });
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.body).toContain('<title>spa</title>');
    const deep = await app.inject({ method: 'GET', url: '/tree/123' });
    expect(deep.headers['cache-control']).toBe('no-store');
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<title>spa</title>');
    const head = await app.inject({ method: 'HEAD', url: '/tree/123' });
    expect(head.statusCode).toBe(200);
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
  });

  it('caches hashed assets forever and the shell never', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-static-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    const app = createServer({ staticDir: dir });
    const asset = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    // The shell carries a per-response nonce, so it is never cached.
    expect((await app.inject({ method: 'GET', url: '/' })).headers['cache-control']).toBe(
      'no-store',
    );
    expect((await app.inject({ method: 'GET', url: '/people' })).headers['cache-control']).toBe(
      'no-store',
    );
  });

  it('allows the bound host in the Host header when it is not loopback', () => {
    expect(allowedHostsFor('127.0.0.1')).toEqual([]);
    expect(allowedHostsFor('::1')).toEqual([]);
    expect(allowedHostsFor('192.168.1.20')).toEqual(['192.168.1.20']);
    expect(allowedHostsFor('fe80::1')).toEqual(['[fe80::1]']);
    expect(allowedHostsFor('0.0.0.0')).toContain('127.0.0.1');
  });

  it('answers malformed HTTP with the security headers', async () => {
    running = await startServer({ port: 0, library: await mkdtemp(join(tmpdir(), 'oa-lib-')) });
    const { port } = new URL(running.url);
    const raw = (request: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(Number(port), '127.0.0.1', () => socket.write(request));
        let data = '';
        socket.on('data', (chunk) => (data += chunk));
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
      });
    const bad = await raw('NOT HTTP\r\n\r\n');
    expect(bad).toMatch(/^HTTP\/1\.1 400 /);
    expect(bad).toContain("content-security-policy: default-src 'self'");
    expect(bad).toContain('x-content-type-options: nosniff');
    expect(bad).toContain('"code":"bad_request"');
    const huge = await raw(
      `GET / HTTP/1.1\r\nhost: localhost\r\nx-big: ${'a'.repeat(20_000)}\r\n\r\n`,
    );
    expect(huge).toMatch(/^HTTP\/1\.1 431 /);
    expect(huge).toContain('referrer-policy: no-referrer');
  });

  it('serves the SPA shell with a per-response style nonce in CSP and a meta tag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-static-'));
    await writeFile(
      join(dir, 'index.html'),
      '<!doctype html><html><head><title>spa</title></head><body></body></html>',
    );
    const app = createServer({ staticDir: dir });
    const nonces: string[] = [];
    for (const url of ['/', '/index.html', '/tree/abc', '/people?sort=birth']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      const nonce = /<meta name="csp-nonce" content="([A-Za-z0-9+/=]+)">/.exec(res.body)?.[1];
      expect(nonce, url).toBeDefined();
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain(`style-src 'self' 'nonce-${nonce}'`);
      expect(csp).toContain("default-src 'self'");
      expect(csp).not.toContain('unsafe-inline');
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-store');
      nonces.push(nonce!);
    }
    expect(new Set(nonces).size).toBe(nonces.length);
    const head = await app.inject({ method: 'HEAD', url: '/' });
    expect(head.statusCode).toBe(200);
    // Other responses keep the plain policy.
    const api = await app.inject({ method: 'GET', url: '/api/health' });
    expect(String(api.headers['content-security-policy'])).not.toContain('nonce');
    await app.close();
  });

  it('serves only regular, non-dot files of the build, matched exactly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-static-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    await writeFile(join(dir, '.env'), 'SECRET=1');
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.git', 'config'), '[core]');
    await mkdir(join(dir, 'assets', '.cache'));
    await writeFile(join(dir, 'assets', '.cache', 'x.js'), 'hidden');
    const outside = await mkdtemp(join(tmpdir(), 'oa-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'OUTSIDE');
    await symlink(outside, join(dir, 'linked'));
    const app = createServer({ staticDir: dir });

    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log(1)');

    for (const url of [
      '/.env',
      '/.git/config',
      '/%2eenv',
      '/assets/.cache/x.js',
      '/assets/',
      '/assets',
      '/INDEX.html',
      '/index.html',
      '/ASSETS/app-abc123.js',
      '/assets/APP-abc123.js',
      '/linked/secret.txt',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body, url).not.toMatch(/SECRET|\[core\]|hidden|OUTSIDE/);
      expect([200, 400, 404], url).toContain(res.statusCode);
      if (res.statusCode === 200) expect(res.body, url).toContain('<title>spa</title>');
    }
    await app.close();
  });
});
