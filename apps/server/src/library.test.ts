import { chmodSync, existsSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from './index';
import { Library, defaultLibraryRoot, treeNameProblem } from './library';
import { testApi, type TestApi } from './test/helpers';

describe('treeNameProblem', () => {
  it.each([
    'Vale Family',
    'Familie Müller',
    "O'Brien 2",
    'a',
    'x'.repeat(100),
    'Conway',
    'console',
    'COM10',
  ])('accepts %j', (name) => {
    expect(treeNameProblem(name)).toBeNull();
  });

  it.each([
    '',
    '.hidden',
    '..',
    '../escape',
    'a/b',
    'a\\b',
    'C:tree',
    'trailing.',
    ' padded',
    'pad ',
    'nul\u0000',
    'tab\there',
    'what?',
    'x'.repeat(101),
    'CON',
    'nul.txt',
    'Com1',
    'lpt9.oatree',
    'AUX',
    'prn',
    '100%',
  ])('rejects %j', (name) => {
    expect(treeNameProblem(name)).not.toBeNull();
  });
});

describe('defaultLibraryRoot', () => {
  it('uses OA_LIBRARY when set, else ~/OpenAncestry', () => {
    expect(defaultLibraryRoot({ OA_LIBRARY: '/tmp/lib' })).toBe('/tmp/lib');
    expect(defaultLibraryRoot({})).toBe(join(homedir(), 'OpenAncestry'));
  });
});

describe('Library', () => {
  it('creates its root lazily and caches one store per tree', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'oa-lib-')), 'nested');
    const library = new Library(root);
    expect(existsSync(root)).toBe(false);
    expect(library.list()).toEqual([]);
    const created = library.create('One');
    expect(library.open('One')).toBe(created);
    library.closeAll();
    const reopened = library.open('One');
    expect(reopened).not.toBe(created);
    expect(library.open('One')).toBe(reopened);
    library.closeAll();
  });

  it('refuses to rename or delete a busy tree', async () => {
    const library = new Library(await mkdtemp(join(tmpdir(), 'oa-lib-')));
    library.create('Busy');
    let release!: () => void;
    const running = library.whileBusy('Busy', () => new Promise<void>((r) => (release = r)));
    expect(() => library.rename('Busy', 'Other')).toThrow(/busy/);
    expect(() => library.delete('Busy')).toThrow(/busy/);
    release();
    await running;
    library.rename('Busy', 'Other');
    expect(library.list().map((t) => t.id)).toEqual(['Other']);
    library.closeAll();
  });
});

describe('tree routes', () => {
  let api: TestApi;
  beforeEach(async () => {
    api = await testApi();
  });
  afterEach(() => api.close());

  it('creates, lists, opens, renames and soft-deletes trees', async () => {
    const created = await api.post('/api/trees', { name: 'Vale Family' });
    expect(created.statusCode).toBe(201);
    expect(created.json().tree).toMatchObject({
      id: 'Vale Family',
      name: 'Vale Family',
      peopleCount: 0,
      homePersonId: null,
    });
    expect(existsSync(join(api.root, 'Vale Family.oatree', 'tree.sqlite'))).toBe(true);

    await api.post('/api/trees', { name: 'Avery' });
    const list = (await api.get('/api/trees')).json().trees;
    expect(list.map((t: { id: string }) => t.id)).toEqual(['Avery', 'Vale Family']);
    expect(list[0].modifiedAt).toMatch(/^\d{4}-/);

    const opened = await api.get('/api/trees/Vale%20Family');
    expect(opened.json().tree.schemaVersion).toBeGreaterThan(0);

    const renamed = await api.patch('/api/trees/Vale%20Family', { name: 'Vale' });
    expect(renamed.json().tree).toMatchObject({ id: 'Vale', name: 'Vale' });
    expect((await api.get('/api/trees/Vale%20Family')).statusCode).toBe(404);
    expect((await api.patch('/api/trees/Vale', { name: 'Vale' })).statusCode).toBe(200);

    const deleted = await api.del('/api/trees/Vale');
    expect(deleted.statusCode).toBe(204);
    expect((await api.get('/api/trees/Vale')).statusCode).toBe(404);
    const trash = await readdir(join(api.root, '.trash'));
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatch(/^Vale .*\.oatree$/);
    // The trash is not a tree.
    expect((await api.get('/api/trees')).json().trees.map((t: { id: string }) => t.id)).toEqual([
      'Avery',
    ]);
  });

  it('refuses duplicate and invalid names', async () => {
    await api.post('/api/trees', { name: 'A' });
    await api.post('/api/trees', { name: 'B' });
    expect((await api.post('/api/trees', { name: 'A' })).json().error.code).toBe('conflict');
    expect((await api.patch('/api/trees/A', { name: 'B' })).statusCode).toBe(409);
    for (const name of ['../x', '.dot', 'a/b']) {
      const res = await api.post('/api/trees', { name });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    expect((await api.post('/api/trees', {})).json().error.code).toBe('validation_failed');
    expect((await api.post('/api/trees', { name: 'A', extra: 1 })).statusCode).toBe(400);
  });

  it('answers 404 or 400 for unknown or path-like tree ids', async () => {
    expect((await api.get('/api/trees/Nope')).json()).toEqual({
      error: { code: 'not_found', message: 'Tree "Nope" not found' },
    });
    expect((await api.get('/api/trees/..%2F..%2Fetc')).statusCode).toBe(400);
    expect((await api.get('/api/trees/.trash')).statusCode).toBe(400);
    expect((await api.patch('/api/trees/Nope', { name: 'X' })).statusCode).toBe(404);
    expect((await api.del('/api/trees/Nope')).statusCode).toBe(404);
  });
});

describe.skipIf(process.platform === 'win32')('library permissions', () => {
  const mode = (path: string) => statSync(path).mode & 0o777;
  const temps: string[] = [];
  const temp = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-lib-'));
    temps.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates the library folder private to its owner', async () => {
    const root = join(await temp(), 'Library');
    const library = new Library(root);
    library.create('Vale');
    expect(mode(root)).toBe(0o700);
    expect(mode(library.dirOf('Vale'))).toBe(0o700);
    library.closeAll();
  });

  it('tightens an existing library folder and its trees on open', async () => {
    const root = join(await temp(), 'Library');
    new Library(root).create('Vale');
    chmodSync(root, 0o755);
    chmodSync(new Library(root).dirOf('Vale'), 0o755);
    const library = new Library(root);
    expect(library.list().map((t) => t.id)).toEqual(['Vale']);
    expect(mode(root)).toBe(0o700);
    expect(mode(library.dirOf('Vale'))).toBe(0o700);
    library.closeAll();
  });

  it('refuses a library folder other accounts can write to, unless it is declared shared', async () => {
    // Issue #211: another account could swap a tree folder between the checks
    // and SQLite opening it by path.
    const root = await temp();
    chmodSync(root, 0o775);
    writeFileSync(join(root, 'notes.txt'), 'not a tree');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => new Library(root).list()).toThrow(
      expect.objectContaining({
        statusCode: 403,
        message: expect.stringMatching(/other accounts can change.*--shared-library/s),
      }),
    );
    expect(() => new Library(root).create('Vale')).toThrow(/--shared-library/);
    for (const writable of [0o757, 0o777]) {
      chmodSync(root, writable);
      expect(() => new Library(root).list()).toThrow(/other accounts can change/);
    }
    chmodSync(root, 0o775);
    const shared = new Library(root, { shared: true });
    shared.create('Vale');
    expect(shared.list().map((t) => t.id)).toEqual(['Vale']);
    shared.closeAll();
    // Not on Windows, where these mode bits mean nothing.
    expect(() => new Library(root, { platform: 'win32' }).list()).not.toThrow();
  });

  it('leaves a shared folder that holds more than trees alone, with a warning', async () => {
    // e.g. `--library ~` or a group-shared folder: chmod would lock others out.
    const root = await temp();
    chmodSync(root, 0o755);
    writeFileSync(join(root, 'notes.txt'), 'not a tree');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const library = new Library(root);
    library.create('Vale');
    expect(mode(root)).toBe(0o755);
    expect(mode(library.dirOf('Vale'))).toBe(0o700);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/other accounts can see/);
    library.list();
    expect(warn).toHaveBeenCalledTimes(1);
    library.closeAll();
  });

  it('warns about a shared library folder once, at startup', async () => {
    const root = await temp();
    chmodSync(root, 0o755);
    writeFileSync(join(root, 'notes.txt'), 'not a tree');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createServer({ library: root });
    expect(warn).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('leaves an existing empty folder alone too, with a warning', async () => {
    const root = await temp();
    chmodSync(root, 0o755);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Library(root).list();
    expect(mode(root)).toBe(0o755);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a planted tree link with a clear 403', async () => {
    const root = join(await temp(), 'Library');
    const library = new Library(root);
    library.create('Real');
    library.closeAll();
    symlinkSync(library.dirOf('Real'), library.dirOf('Planted'));
    expect(() => library.open('Planted')).toThrow(
      expect.objectContaining({ statusCode: 403, message: expect.stringMatching(/symbolic link/) }),
    );
  });

  it('keeps the trash private', async () => {
    const root = join(await temp(), 'Library');
    const library = new Library(root);
    library.create('Gone');
    library.delete('Gone');
    expect(mode(join(root, '.trash'))).toBe(0o700);
    library.closeAll();
  });
});
