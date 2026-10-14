import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTree, meta, openMemoryTree, openTree, persons, treePaths } from './index';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-db-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(process.platform === 'win32')('tree permissions', () => {
  it('creates the tree private to its owner: folders 0700, database files 0600', () => {
    const dir = join(root, 'Private.oatree');
    const store = createTree(dir);
    store.db.prepare("INSERT INTO meta (key, value) VALUES ('probe', 'x')").run();
    const paths = treePaths(dir);
    for (const folder of [dir, paths.media, paths.thumbs]) expect(mode(folder), folder).toBe(0o700);
    for (const file of [paths.database, `${paths.database}-wal`, `${paths.database}-shm`]) {
      expect(existsSync(file), file).toBe(true);
      expect(mode(file), file).toBe(0o600);
    }
    store.close();
  });

  it('tightens an existing tree when it opens', () => {
    const dir = join(root, 'Old.oatree');
    createTree(dir).close();
    const paths = treePaths(dir);
    for (const folder of [dir, paths.media, paths.thumbs]) chmodSync(folder, 0o755);
    chmodSync(paths.database, 0o644);
    const store = openTree(dir);
    for (const folder of [dir, paths.media, paths.thumbs]) expect(mode(folder), folder).toBe(0o700);
    expect(mode(paths.database)).toBe(0o600);
    store.close();
  });
});

describe('tree storage layout', () => {
  it('creates <name>.oatree with tree.sqlite, media/ and thumbs/', () => {
    const dir = join(root, 'Vale Family.oatree');
    const store = createTree(dir, { name: 'Vale Family' });
    const paths = treePaths(dir);
    expect(paths.database).toBe(join(dir, 'tree.sqlite'));
    expect(statSync(paths.media).isDirectory()).toBe(true);
    expect(statSync(paths.thumbs).isDirectory()).toBe(true);
    expect(existsSync(paths.database)).toBe(true);
    expect(store.dir).toBe(dir);
    expect(meta.get(store, 'tree_name')).toBe('Vale Family');
    store.close();
  });

  it('applies the expected pragmas to file databases', () => {
    const store = createTree(join(root, 'p.oatree'));
    const pragma = (name: string) => store.db.pragma(name, { simple: true });
    expect(pragma('journal_mode')).toBe('wal');
    expect(pragma('foreign_keys')).toBe(1);
    expect(pragma('synchronous')).toBe(1); // NORMAL
    expect(pragma('temp_store')).toBe(2); // MEMORY
    expect(Number(pragma('mmap_size'))).toBeGreaterThan(0);
    expect(Number(pragma('cache_size'))).toBeLessThan(0); // negative = KiB
    store.close();
  });

  it('reopens an existing tree and keeps its data', () => {
    const dir = join(root, 'keep.oatree');
    const store = createTree(dir);
    const { result: person } = store.transact('add', (tx) =>
      persons.create(tx, { sex: 'F', names: [{ given: 'Hazel', surname: 'Moor' }] }),
    );
    store.close();
    const reopened = openTree(dir);
    expect(persons.get(reopened, person.id)?.sex).toBe('F');
    reopened.close();
  });

  it('defaults the tree name to the folder name', () => {
    const store = createTree(join(root, 'Holt Line.oatree'));
    expect(meta.get(store, 'tree_name')).toBe('Holt Line');
    store.close();
  });

  it('rejects folder names without the .oatree extension', () => {
    expect(() => createTree(join(root, 'nope'))).toThrow(/\.oatree/);
    expect(() => openTree(join(root, 'nope'))).toThrow(/\.oatree/);
  });

  it('refuses to create over an existing tree', () => {
    const dir = join(root, 'twice.oatree');
    createTree(dir).close();
    expect(() => createTree(dir)).toThrow(/exists/);
  });

  it('refuses to open a missing tree', () => {
    expect(() => openTree(join(root, 'missing.oatree'))).toThrow(/not found/);
  });

  it('refuses to open a folder whose tree.sqlite is not a database', () => {
    const dir = join(root, 'bad.oatree');
    createTree(dir).close();
    writeFileSync(join(dir, 'tree.sqlite'), 'not a database');
    rmSync(join(dir, 'tree.sqlite-wal'), { force: true });
    rmSync(join(dir, 'tree.sqlite-shm'), { force: true });
    expect(() => openTree(dir)).toThrow();
  });

  it('opens in-memory trees for tests and tools', () => {
    const store = openMemoryTree({ name: 'scratch' });
    expect(store.dir).toBeNull();
    expect(meta.get(store, 'tree_name')).toBe('scratch');
    expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1);
    store.close();
  });
});
