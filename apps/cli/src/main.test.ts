import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs, run } from './main';

describe('parseCliArgs', () => {
  it('parses serve with defaults', () => {
    expect(parseCliArgs(['serve'])).toEqual({
      command: 'serve',
      host: '127.0.0.1',
      port: 4317,
      staticDir: undefined,
    });
  });

  it('parses serve options', () => {
    expect(parseCliArgs(['serve', '--port', '9000', '--static-dir', '/tmp/web'])).toMatchObject({
      port: 9000,
      staticDir: '/tmp/web',
    });
  });

  it('rejects an invalid port', () => {
    expect(() => parseCliArgs(['serve', '--port', 'abc'])).toThrow(/port/);
  });

  it('returns help for no command', () => {
    expect(parseCliArgs([])).toEqual({ command: 'help' });
  });
});

describe('run', () => {
  it('serve starts the server and serves the web build', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-cli-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>cli</title>');
    const logs: string[] = [];
    const result = await run(['serve', '--port', '0', '--static-dir', dir], (line) =>
      logs.push(line),
    );
    if (!result) throw new Error('expected a running server');
    try {
      const page = await fetch(result.url);
      expect(await page.text()).toContain('<title>cli</title>');
      expect(logs.join('\n')).toContain(result.url);
    } finally {
      await result.close();
    }
  });

  it('prints usage for help', async () => {
    const logs: string[] = [];
    expect(await run(['help'], (line) => logs.push(line))).toBeUndefined();
    expect(logs.join('\n')).toMatch(/Usage: open-ancestry/);
  });
});
