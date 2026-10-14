import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { generateGedcom } from '../../../fixtures/generate';
import { exposureWarning, parseCliArgs, progressReporter, run } from './main';
import { makeTempDir } from '../../../fixtures/temp-dir';

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
    const dir = makeTempDir('oa-cli-');
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>cli</title>');
    const library = makeTempDir('oa-cli-lib-');
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

const fixture = join(import.meta.dirname, '../../../fixtures/ancestry-sample.ged');

describe('import', () => {
  async function importCli(args: string[]) {
    const library = makeTempDir('oa-cli-import-');
    const logs: string[] = [];
    const errors: string[] = [];
    await run(['import', ...args, '--library', library], {
      log: (line) => logs.push(line),
      warn: (line) => errors.push(line),
    });
    return { library, out: logs.join('\n'), err: errors.join('\n') };
  }

  it('parses import options', () => {
    expect(
      parseCliArgs(['import', 'a.ged', '--media', 'pics', '--name', 'Vale', '--library', '/l'], {}),
    ).toEqual({ command: 'import', file: 'a.ged', media: 'pics', name: 'Vale', library: '/l' });
    expect(() => parseCliArgs(['import'], {})).toThrow(/file/);
  });

  it('creates a tree named after the file and prints the report', async () => {
    const { library, out } = await importCli([fixture]);
    expect(existsSync(join(library, 'ancestry-sample.oatree', 'tree.sqlite'))).toBe(true);
    expect(out).toMatch(/Imported ancestry-sample\.ged into "ancestry-sample"/);
    expect(out).toMatch(/People\s+26/);
    expect(out).toMatch(/Families\s+10/);
    expect(out).toMatch(/Lines\s+475 \(458 mapped, 17 preserved\)/);
    expect(out).toMatch(/Warnings\s+none/);
    expect(out).toMatch(/Home person\s+Thaddeus Ashgrove/);
    expect(out).toContain('Ancestry.com Family Trees 2024.12');
  });

  it('uses --name and --media, and lists warnings and unmapped tags', async () => {
    const dir = makeTempDir('oa-cli-ged-');
    const ged = join(dir, 'family.ged');
    await writeFile(
      ged,
      [
        '0 HEAD',
        '0 @I1@ INDI',
        '1 FAMC @F9@',
        '1 _ODD x',
        '1 OBJE',
        '2 FILE p/a.jpg',
        '0 TRLR',
        '',
      ].join('\n'),
    );
    await mkdir(join(dir, 'media', 'p'), { recursive: true });
    await writeFile(join(dir, 'media', 'p', 'a.jpg'), 'jpeg');
    const { library, out } = await importCli([
      ged,
      '--name',
      'Vale',
      '--media',
      join(dir, 'media'),
    ]);
    expect(existsSync(join(library, 'Vale.oatree', 'media', 'p', 'a.jpg'))).toBe(true);
    expect(out).toMatch(/Media\s+1 linked/);
    expect(out).toMatch(/line 3\s+bad-pointer/);
    expect(out).toMatch(/INDI\._ODD\s+1\s+line 4: 1 _ODD x/);
  });

  it('refuses an existing tree name and a bad name without touching the library', async () => {
    const { library } = await importCli([fixture, '--name', 'Twice']);
    await expect(
      run(['import', fixture, '--name', 'Twice', '--library', library], { log: () => {} }),
    ).rejects.toThrow(/already exists/);
    await expect(
      run(['import', fixture, '--name', 'a/b', '--library', library], { log: () => {} }),
    ).rejects.toThrow(/path separator/);
  });

  it('refuses a --media folder that does not exist', async () => {
    const library = makeTempDir('oa-cli-media-');
    await expect(
      run(['import', fixture, '--media', join(library, 'nope'), '--library', library], {
        log: () => {},
      }),
    ).rejects.toThrow(/--media folder not found/);
    await expect(
      run(['import', fixture, '--media', fixture, '--library', library], { log: () => {} }),
    ).rejects.toThrow(/--media folder not found/);
    expect(existsSync(join(library, 'ancestry-sample.oatree'))).toBe(false);
  });

  it('writes progress lines when asked (stderr on a terminal)', async () => {
    const library = makeTempDir('oa-cli-progress-');
    const chunks: string[] = [];
    await run(['import', fixture, '--library', library], {
      log: () => {},
      progress: (text) => chunks.push(text),
    });
    const text = chunks.join('');
    expect(text).toContain('Parsing');
    expect(text).toContain('Mapping records 100%');
    expect(text.endsWith('\n')).toBe(true);
    const lines: string[] = [];
    const report = progressReporter((t) => lines.push(t.trim()));
    for (let done = 0; done <= 1000; done += 50) report('map', done, 1000);
    report('map', 1000, 1000);
    expect(lines).toEqual(Array.from({ length: 11 }, (_, i) => `Mapping records ${i * 10}%`));
  });

  it('fails cleanly on a missing or non-GEDCOM file', async () => {
    const library = makeTempDir('oa-cli-bad-');
    await expect(
      run(['import', join(library, 'nope.ged'), '--library', library], { log: () => {} }),
    ).rejects.toThrow(/Cannot read/);
    const junk = join(library, 'junk.ged');
    await writeFile(junk, 'not a gedcom\n');
    await expect(run(['import', junk, '--library', library], { log: () => {} })).rejects.toThrow(
      /does not look like GEDCOM/,
    );
    expect(existsSync(join(library, 'junk.oatree'))).toBe(false);
  });
});

describe('serve with import', () => {
  it('wires the real importer into the server', async () => {
    const dir = makeTempDir('oa-cli-');
    await writeFile(join(dir, 'index.html'), '<!doctype html>');
    const library = makeTempDir('oa-cli-lib-');
    const server = await run(['serve', '--port', '0', '--static-dir', dir, '--library', library], {
      log: () => {},
    });
    if (!server) throw new Error('expected a server');
    try {
      const { token } = (await (await fetch(`${server.url}/api/session`)).json()) as {
        token: string;
      };
      const headers = { origin: server.url, 'x-oa-token': token };
      await fetch(`${server.url}/api/trees`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Served' }),
      });
      const form = new FormData();
      form.append('file', new Blob([await readFile(fixture)]), 'ancestry-sample.ged');
      const started = await fetch(`${server.url}/api/trees/Served/import`, {
        method: 'POST',
        headers,
        body: form,
      });
      expect(started.status).toBe(202);
      const { jobId } = (await started.json()) as { jobId: string };
      let job: { state: string; result: { records: { INDI: number } }; progress: unknown };
      do {
        await new Promise((r) => setTimeout(r, 20));
        job = (await (await fetch(`${server.url}/api/jobs/${jobId}`)).json()) as typeof job;
      } while (job.state === 'queued' || job.state === 'running');
      expect(job.state).toBe('completed');
      expect(job.result.records.INDI).toBe(26);
      expect(job.progress).toMatchObject({ phase: 'done' });
    } finally {
      await server.close();
    }
  });
});

describe('serve on SIGINT/SIGTERM', () => {
  it('aborts a running import, cleans up its new tree and upload, then exits 0', async () => {
    const dir = makeTempDir('oa-cli-');
    await writeFile(join(dir, 'index.html'), '<!doctype html>');
    const library = makeTempDir('oa-cli-lib-');
    const signals = new EventEmitter();
    const exits: number[] = [];
    const logs: string[] = [];
    const server = await run(['serve', '--port', '0', '--static-dir', dir, '--library', library], {
      log: (line) => logs.push(line),
      signals: signals as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
      exit: (code) => exits.push(code),
    });
    if (!server) throw new Error('expected a server');
    const { token } = (await (await fetch(`${server.url}/api/session`)).json()) as {
      token: string;
    };
    // Big enough that the import is still running when the signal arrives.
    const form = new FormData();
    form.append('file', new Blob([generateGedcom({ people: 40_000, seed: 4 })]), 'Big Family.ged');
    const started = await fetch(`${server.url}/api/import`, {
      method: 'POST',
      headers: { origin: server.url, 'x-oa-token': token },
      body: form,
    });
    const { jobId, job } = (await started.json()) as { jobId: string; job: { tree: string } };
    let state = 'queued';
    while (state === 'queued') {
      await new Promise((r) => setTimeout(r, 10));
      state = ((await (await fetch(`${server.url}/api/jobs/${jobId}`)).json()) as { state: string })
        .state;
    }
    expect(state).toBe('running');
    expect(existsSync(join(library, `${job.tree}.oatree`))).toBe(true);

    signals.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 10_000 });
    expect(logs).toContain('Stopping (SIGTERM)...');
    expect(existsSync(join(library, `${job.tree}.oatree`))).toBe(false);
    await expect(fetch(`${server.url}/api/health`)).rejects.toThrow();
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    await server.close();
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  }, 30_000);

  it('exits at once on a second signal', async () => {
    const dir = makeTempDir('oa-cli-');
    await writeFile(join(dir, 'index.html'), '<!doctype html>');
    const library = makeTempDir('oa-cli-lib-');
    const signals = new EventEmitter();
    const exits: number[] = [];
    const server = await run(['serve', '--port', '0', '--static-dir', dir, '--library', library], {
      log: () => {},
      signals: signals as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
      exit: (code) => exits.push(code),
    });
    signals.emit('SIGINT', 'SIGINT');
    signals.emit('SIGINT', 'SIGINT');
    expect(exits).toEqual([1]);
    await vi.waitFor(() => expect(exits).toEqual([1, 0]));
    await server?.close();
  });
});
