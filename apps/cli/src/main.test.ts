import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { generateGedcom } from '../../../fixtures/generate';
import { openMemoryTree } from '@open-ancestry/db';
import { importGedcom } from '@open-ancestry/import';
import {
  exposureWarning,
  formatReport,
  main,
  parseCliArgs,
  progressReporter,
  run,
  stopOnSignals,
} from './main';

describe('parseCliArgs', () => {
  it('parses serve with defaults', () => {
    expect(parseCliArgs(['serve'], {}, { tty: false })).toEqual({
      command: 'serve',
      host: '127.0.0.1',
      port: 4317,
      library: join(homedir(), 'OpenAncestry'),
      open: false,
      staticDir: undefined,
      importLimits: {},
      importHeapMb: undefined,
      sharedLibrary: false,
    });
  });

  it('reads import size and heap limits from flags, then OA_ variables', () => {
    const MiB = 1024 * 1024;
    expect(
      parseCliArgs(
        ['serve', '--max-gedcom-mb', '128', '--max-archive-mb', '4096', '--import-heap-mb', '3072'],
        {},
      ),
    ).toMatchObject({
      importLimits: { maxBytes: 128 * MiB, maxArchiveBytes: 4096 * MiB },
      importHeapMb: 3072,
    });
    const env = { OA_MAX_GEDCOM_MB: '100', OA_MAX_ARCHIVE_MB: '2048', OA_IMPORT_HEAP_MB: '4096' };
    expect(parseCliArgs(['serve'], env)).toMatchObject({
      importLimits: { maxBytes: 100 * MiB, maxArchiveBytes: 2048 * MiB },
      importHeapMb: 4096,
    });
    // A flag wins over the variable.
    expect(parseCliArgs(['import', 'a.ged', '--max-gedcom-mb', '10'], env)).toMatchObject({
      importLimits: { maxBytes: 10 * MiB, maxArchiveBytes: 2048 * MiB },
    });
    expect(() => parseCliArgs(['serve', '--max-gedcom-mb', 'lots'], {})).toThrow(/--max-gedcom-mb/);
    expect(() => parseCliArgs(['serve'], { OA_IMPORT_HEAP_MB: '0' })).toThrow(/OA_IMPORT_HEAP_MB/);
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

  it('reads --shared-library and OA_SHARED_LIBRARY=1 (issue #211)', () => {
    expect(parseCliArgs(['serve'], {})).toMatchObject({ sharedLibrary: false });
    expect(parseCliArgs(['serve', '--shared-library'], {})).toMatchObject({ sharedLibrary: true });
    expect(parseCliArgs(['serve'], { OA_SHARED_LIBRARY: '1' })).toMatchObject({
      sharedLibrary: true,
    });
    expect(parseCliArgs(['import', 'a.ged', '--shared-library'], {})).toMatchObject({
      sharedLibrary: true,
    });
  });

  it('rejects an invalid port', () => {
    expect(() => parseCliArgs(['serve', '--port', 'abc'])).toThrow(/port/);
  });

  it('opens the browser by default on a terminal, unless --no-open (issue #122)', () => {
    expect(parseCliArgs(['serve'], {}, { tty: true })).toMatchObject({ open: true });
    // Piped or scripted output (CI, e2e) gets no browser unless asked.
    expect(parseCliArgs(['serve'], {}, { tty: false })).toMatchObject({ open: false });
    expect(parseCliArgs(['serve', '--no-open'], {}, { tty: true })).toMatchObject({ open: false });
    expect(parseCliArgs(['serve', '--open'], {}, { tty: false })).toMatchObject({ open: true });
  });

  it('reads -h and --help, for the CLI and for each command (issue #119)', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['-h'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['serve', '--help'])).toEqual({ command: 'help', topic: 'serve' });
    expect(parseCliArgs(['import', '-h'])).toEqual({ command: 'help', topic: 'import' });
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

  it('exits 0 with usage for --help, per command too', async () => {
    const logs: string[] = [];
    expect(await main(['--help'], { log: (line) => logs.push(line) })).toBe(0);
    expect(logs.join('\n')).toMatch(/^Usage: open-ancestry <command>/);
    logs.length = 0;
    expect(await main(['serve', '--help'], { log: (line) => logs.push(line) })).toBe(0);
    expect(logs.join('\n')).toMatch(/^Usage: open-ancestry serve/);
    expect(logs.join('\n')).toContain('--no-open');
    expect(logs.join('\n')).not.toContain('--media');
    logs.length = 0;
    expect(await main(['import', '--help'], { log: (line) => logs.push(line) })).toBe(0);
    expect(logs.join('\n')).toMatch(/^Usage: open-ancestry import <file>/);
    expect(logs.join('\n')).not.toContain('--port');
  });

  it('exits 2 with a one-line message and usage for unknown commands and options', async () => {
    for (const [argv, message] of [
      [['bogus'], 'Unknown command: bogus'],
      [['serve', '--bogus'], 'Unknown option: --bogus'],
      [['import', 'a.ged', '-x'], 'Unknown option: -x'],
    ] as const) {
      const errors: string[] = [];
      const logs: string[] = [];
      const code = await main([...argv], {
        error: (line) => errors.push(line),
        log: (line) => logs.push(line),
      });
      expect(code).toBe(2);
      const [first, ...rest] = errors.join('\n').split('\n');
      expect(first).toBe(message);
      expect(rest.join('\n')).toContain('Usage: open-ancestry');
      expect(logs).toEqual([]);
    }
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
    const library = await mkdtemp(join(tmpdir(), 'oa-cli-import-'));
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
    ).toEqual({
      command: 'import',
      file: 'a.ged',
      media: 'pics',
      name: 'Vale',
      library: '/l',
      importLimits: {},
      sharedLibrary: false,
    });
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
    const dir = await mkdtemp(join(tmpdir(), 'oa-cli-ged-'));
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

  it.skipIf(process.platform === 'win32')(
    'refuses a library folder other accounts can write to, unless --shared-library',
    async () => {
      const library = await mkdtemp(join(tmpdir(), 'oa-cli-shared-'));
      await writeFile(join(library, 'notes.txt'), 'not a tree');
      await chmod(library, 0o775);
      const args = ['import', fixture, '--name', 'Shared', '--library', library];
      await expect(run(args, { log: () => {}, warn: () => {} })).rejects.toThrow(
        /--shared-library/,
      );
      expect(existsSync(join(library, 'Shared.oatree'))).toBe(false);
      await run([...args, '--shared-library'], { log: () => {}, warn: () => {} });
      expect(existsSync(join(library, 'Shared.oatree'))).toBe(true);
    },
  );

  it('applies --max-gedcom-mb to the import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-cli-big-'));
    const big = join(dir, 'big.ged');
    await writeFile(big, `0 HEAD\n0 @I1@ INDI\n1 NOTE ${'x'.repeat(1024)}\n`.repeat(1100));
    await expect(importCli([big, '--max-gedcom-mb', '1'])).rejects.toThrow(/over 1048576 bytes/);
  });

  it('refuses a --media folder that does not exist', async () => {
    const library = await mkdtemp(join(tmpdir(), 'oa-cli-media-'));
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
    const library = await mkdtemp(join(tmpdir(), 'oa-cli-progress-'));
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
    const library = await mkdtemp(join(tmpdir(), 'oa-cli-bad-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'oa-cli-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html>');
    const library = await mkdtemp(join(tmpdir(), 'oa-cli-lib-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'oa-cli-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html>');
    const library = await mkdtemp(join(tmpdir(), 'oa-cli-lib-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'oa-cli-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html>');
    const library = await mkdtemp(join(tmpdir(), 'oa-cli-lib-'));
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

  it('says why stopping failed before exiting 1', async () => {
    const signals = new EventEmitter();
    const exits: number[] = [];
    const logs: string[] = [];
    stopOnSignals(
      {
        url: 'http://127.0.0.1:1',
        app: {} as never,
        close: () => Promise.reject(new Error('Plugin did not start in time: preClose')),
      },
      signals as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
      (code) => exits.push(code),
      (line) => logs.push(line),
    );
    signals.emit('SIGINT', 'SIGINT');
    await vi.waitFor(() => expect(exits).toEqual([1]));
    expect(logs.at(-1)).toBe('Could not stop cleanly: Plugin did not start in time: preClose');
  });
});

describe('formatReport layout (issue #121)', () => {
  async function report(lines: string[]) {
    return importGedcom(
      { bytes: ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', ...lines, '0 TRLR', ''].join('\n') },
      openMemoryTree(),
      { today: new Date('2026-10-14T12:00:00Z') },
    );
  }
  const tree = { name: 'T', dir: '/lib/T.oatree', homePerson: null };

  it('keeps a space between columns and shortens long examples', async () => {
    const r = await report([
      '0 @I1@ INDI',
      '1 NOTE start',
      '1 CONC stray continuation',
      `1 _LONG ${'x'.repeat(500)}`,
    ]);
    const out = formatReport(r, tree).split('\n');
    const warning = out.find((l) => l.includes('misplaced-continuation'))!;
    expect(warning).toMatch(/misplaced-continuation +\S/);
    const long = out.find((l) => l.includes('INDI._LONG'))!;
    expect(long.length).toBeLessThanOrEqual(130);
    expect(long.endsWith('…')).toBe(true);
  });

  it('reads short imports as under 0.1s, not 0.0s', async () => {
    const r = await report(['0 @I1@ INDI']);
    r.timings.total = 12;
    expect(formatReport(r, tree).split('\n')[0]).toMatch(/ in under 0\.1s$/);
    r.timings.total = 1234;
    expect(formatReport(r, tree).split('\n')[0]).toMatch(/ in 1\.2s$/);
  });
});
