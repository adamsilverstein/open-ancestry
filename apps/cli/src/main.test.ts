import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exposureWarning, parseCliArgs, run } from './main';

describe('parseCliArgs', () => {
  it('parses serve with defaults', () => {
    expect(parseCliArgs(['serve'], {})).toEqual({
      command: 'serve',
      host: '127.0.0.1',
      port: 4317,
      library: join(homedir(), 'OpenAncestry'),
      open: false,
      staticDir: undefined,
    });
  });

  it('parses serve options', () => {
    expect(
      parseCliArgs(
        ['serve', '--port', '9000', '--static-dir', '/tmp/web', '--library', '/tmp/lib', '--open'],
        {},
      ),
    ).toMatchObject({ port: 9000, staticDir: '/tmp/web', library: '/tmp/lib', open: true });
  });

  it('reads the library from OA_LIBRARY', () => {
    expect(parseCliArgs(['serve'], { OA_LIBRARY: '/tmp/env-lib' })).toMatchObject({
      library: '/tmp/env-lib',
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
  async function serve(extra: string[] = []) {
    const dir = await mkdtemp(join(tmpdir(), 'oa-cli-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>cli</title>');
    const library = await mkdtemp(join(tmpdir(), 'oa-cli-lib-'));
    const logs: string[] = [];
    const warnings: string[] = [];
    const opened: string[] = [];
    const result = await run(
      ['serve', '--port', '0', '--static-dir', dir, '--library', library, ...extra],
      {
        log: (line) => logs.push(line),
        warn: (line) => warnings.push(line),
        openUrl: (url) => opened.push(url),
      },
    );
    if (!result) throw new Error('expected a running server');
    return { result, logs, warnings, opened, library };
  }

  it('serve starts the server on loopback and serves the web build', async () => {
    const { result, logs, warnings, opened, library } = await serve();
    try {
      expect(new URL(result.url).hostname).toBe('127.0.0.1');
      const page = await fetch(result.url);
      expect(await page.text()).toContain('<title>cli</title>');
      expect(logs.join('\n')).toContain(result.url);
      expect(logs.join('\n')).toContain(library);
      expect(warnings).toEqual([]);
      expect(opened).toEqual([]);
      const trees = await fetch(`${result.url}/api/trees`);
      expect(await trees.json()).toEqual({ trees: [] });
    } finally {
      await result.close();
    }
  });

  it('--open opens the browser at the server URL', async () => {
    const { result, opened } = await serve(['--open']);
    try {
      expect(opened).toEqual([result.url]);
    } finally {
      await result.close();
    }
  });

  it('warns loudly when the host is not loopback', () => {
    expect(exposureWarning('0.0.0.0')).toMatch(/WARNING: listening on 0\.0\.0\.0/);
  });

  it('prints usage for help', async () => {
    const logs: string[] = [];
    expect(await run(['help'], { log: (line) => logs.push(line) })).toBeUndefined();
    expect(logs.join('\n')).toMatch(/--library/);
  });
});
