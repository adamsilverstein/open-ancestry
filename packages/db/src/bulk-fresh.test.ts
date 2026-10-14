import { describe, expect, it } from 'vitest';
import {
  BulkWriter,
  bulkInsert,
  dumpSchema,
  exportJsonString,
  generateSyntheticTree,
  persons,
  searchPeople,
} from './index';
import { memoryTree } from './test/helpers';

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

  it('refuses a tree that already has data', () => {
    const store = memoryTree();
    store.transact('add', (tx) => persons.create(tx, {}));
    expect(() => new BulkWriter(store, { freshTree: true })).toThrow(/empty tree/);
    expect(store.db.inTransaction).toBe(false);
    store.close();
  });
});
