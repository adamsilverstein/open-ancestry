import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BulkWriter,
  bulkInsert,
  createTree,
  openTree,
  dumpSchema,
  exportJsonString,
  generateSyntheticTree,
  persons,
  searchPeople,
} from './index';
import { memoryTree } from './test/helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

/** Loading into a brand-new tree defers secondary indexes and foreign key checks to commit. */
describe('bulk load into a fresh tree', () => {
  const pragmas = (store: ReturnType<typeof memoryTree>) => ({
    foreignKeys: store.db.pragma('foreign_keys', { simple: true }),
    cacheSize: store.db.pragma('cache_size', { simple: true }),
  });

  it('produces exactly the same tree and schema as a normal load', () => {
    const data = generateSyntheticTree({ people: 400, seed: 5 });
    const normal = memoryTree();
    bulkInsert(normal, data);
    const fresh = memoryTree();
    const before = pragmas(fresh);
    bulkInsert(fresh, data, { freshTree: true });
    expect(exportJsonString(fresh)).toBe(exportJsonString(normal));
    expect(dumpSchema(fresh.db)).toBe(dumpSchema(normal.db));
    expect(pragmas(fresh)).toEqual(before);
    const surname = data.person_name[0]?.surname as string;
    expect(searchPeople(fresh, surname).length).toBe(searchPeople(normal, surname).length);
    normal.close();
    fresh.close();
  });

  it('still refuses dangling references, at commit, and restores everything', () => {
    const store = memoryTree();
    const before = { schema: dumpSchema(store.db), ...pragmas(store) };
    const writer = new BulkWriter(store, { freshTree: true });
    writer.insert('person', { id: 'P1' });
    writer.insert('person_name', { person_id: 'MISSING' });
    expect(() => writer.commit()).toThrow(/FOREIGN KEY constraint failed: person_name/);
    expect(store.db.inTransaction).toBe(false);
    expect({ schema: dumpSchema(store.db), ...pragmas(store) }).toEqual(before);
    expect(persons.list(store)).toEqual([]);
    store.close();
  });

  it('restores indexes and pragmas after a rollback', () => {
    const store = memoryTree();
    const before = { schema: dumpSchema(store.db), ...pragmas(store) };
    const writer = new BulkWriter(store, { freshTree: true });
    writer.insert('person', { id: 'P1' });
    writer.rollback();
    expect({ schema: dumpSchema(store.db), ...pragmas(store) }).toEqual(before);
    store.close();
  });

  it('refuses a tree that already has data or history', () => {
    const store = memoryTree();
    store.transact('add', (tx) => persons.create(tx, {}));
    expect(() => new BulkWriter(store, { freshTree: true })).toThrow(/empty tree/);
    // History alone (everything since undone, or deleted) also counts.
    store.db.exec('DELETE FROM person');
    expect(() => new BulkWriter(store, { freshTree: true })).toThrow(/empty tree/);
    expect(store.db.inTransaction).toBe(false);
    store.close();
  });
});

describe('batched inserts', () => {
  it('buffers rows per table and writes them on flush, in order', () => {
    const store = memoryTree();
    const writer = new BulkWriter(store);
    const ids = Array.from({ length: 70 }, (_, i) =>
      writer.insert('person', { id: `P${String(i).padStart(3, '0')}` }),
    );
    expect(ids[69]).toBe('P069');
    writer.flush();
    expect(
      (store.db.prepare('SELECT id FROM person ORDER BY rowid').all() as { id: string }[]).map(
        (r) => r.id,
      ),
    ).toEqual(ids);
    writer.insert('person', { id: 'P999' });
    expect(writer.commit()).toMatchObject({ person: 71 });
    expect(persons.list(store)).toHaveLength(71);
    store.close();
  });

  it('reports a constraint failure in a buffered batch and rolls back', () => {
    const store = memoryTree();
    const writer = new BulkWriter(store);
    writer.insert('person', { id: 'DUP' });
    writer.insert('person', { id: 'DUP' });
    expect(() => writer.commit()).toThrow(/UNIQUE constraint failed: person.id/);
    expect(store.db.inTransaction).toBe(false);
    expect(persons.list(store)).toEqual([]);
    store.close();
  });
});

describe('journal mode during a fresh-tree load', () => {
  it('writes a new on-disk tree without WAL, then switches WAL back on', () => {
    const root = makeTempDir('oa-fresh-');
    try {
      const store = createTree(join(root, 'f.oatree'));
      expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
      const writer = new BulkWriter(store, { freshTree: true, soleConnection: true });
      // A rollback journal writes new pages once; WAL writes them twice (log, then checkpoint).
      expect(store.db.pragma('journal_mode', { simple: true })).toBe('delete');
      writer.insert('person', { id: 'P1' });
      writer.commit();
      expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
      store.close();

      const reopened = openTree(join(root, 'f.oatree'));
      expect(persons.list(reopened)).toHaveLength(1);
      reopened.close();

      const other = createTree(join(root, 'g.oatree'));
      const aborted = new BulkWriter(other, { freshTree: true, soleConnection: true });
      aborted.rollback();
      expect(other.db.pragma('journal_mode', { simple: true })).toBe('wal');
      // Without soleConnection the tree stays in WAL, since others may have it open.
      const shared = new BulkWriter(other, { freshTree: true });
      expect(other.db.pragma('journal_mode', { simple: true })).toBe('wal');
      shared.rollback();
      other.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
