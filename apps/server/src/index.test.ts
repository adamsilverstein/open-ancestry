import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, startServer, type RunningServer } from './index';

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
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const app = createServer();
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
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
});
