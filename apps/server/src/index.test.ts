import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
    expect((await app.inject({ method: 'GET', url: '/' })).headers['cache-control']).toBe(
      'no-cache',
    );
    expect((await app.inject({ method: 'GET', url: '/people' })).headers['cache-control']).toBe(
      'no-cache',
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
});
