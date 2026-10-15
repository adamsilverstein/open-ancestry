import { existsSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('resolves an id to its folder as spelled on disk, without folding case', async () => {
    const library = new Library(await mkdtemp(join(tmpdir(), 'oa-lib-')));
    const created = library.create('Caf\u00e9');
    // NFD and NFC spellings are one tree: one connection, one busy state.
    expect(library.open('Cafe\u0301')).toBe(created);
    expect(library.canonical('Cafe\u0301')).toBe('Caf\u00e9');
    const release = library.markBusy('Cafe\u0301');
    expect(library.isBusy('Caf\u00e9')).toBe(true);
    release();
    expect(library.isBusy('Caf\u00e9')).toBe(false);
    // A case variant is a different (missing) tree on every file system.
    expect(library.exists('CAF\u00c9')).toBe(false);
    expect(() => library.open('caf\u00e9')).toThrow(/not found/);
    expect(library.list().map((t) => t.id)).toEqual(['Caf\u00e9']);
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
