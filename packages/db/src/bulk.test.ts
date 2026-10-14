import { describe, expect, it } from 'vitest';
import {
  BulkWriter,
  bulkInsert,
  generateSyntheticTree,
  getNeighborhood,
  getPersonDetail,
  names,
  searchPeople,
} from './index';
import { memoryTree } from './test/helpers';

describe('bulk insert', () => {
  it('inserts a generated tree in one transaction without change_log rows', () => {
    const store = memoryTree();
    const data = generateSyntheticTree({ people: 500, seed: 3 });
    const counts = bulkInsert(store, data);
    expect(counts.person).toBe(500);
    expect(counts.person_name).toBe(500);
    expect(counts.family).toBeGreaterThan(100);
    const n = (t: string) =>
      (store.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(n('person')).toBe(500);
    expect(n('change_log')).toBe(0);
    expect(n('change_batch')).toBe(0);
    expect(n('person_search')).toBe(500);
    expect(n('import_batch')).toBe(1);
    store.close();
  });

  it('is deterministic for a seed', () => {
    expect(generateSyntheticTree({ people: 50, seed: 9 })).toEqual(
      generateSyntheticTree({ people: 50, seed: 9 }),
    );
  });

  it('produces a queryable, searchable tree', () => {
    const store = memoryTree();
    const data = generateSyntheticTree({ people: 300, seed: 1 });
    bulkInsert(store, data);
    const focus = data.focusId;
    const hood = getNeighborhood(store, focus, { up: 4, down: 3 });
    expect(hood.people.length).toBeGreaterThan(5);
    expect(getPersonDetail(store, focus)?.names.length).toBe(1);
    const surname = names.list(store, focus)[0]?.surname as string;
    expect(searchPeople(store, surname).length).toBeGreaterThan(0);
    store.close();
  });

  it('fills defaults, marks a primary name, and rolls back on error', () => {
    const store = memoryTree();
    const writer = new BulkWriter(store);
    writer.insert('person', { id: 'P1' });
    writer.insert('person_name', { person_id: 'P1', given: 'Alder', sort_order: 1 });
    writer.insert('person_name', { person_id: 'P1', given: 'Al', sort_order: 2, type: 'aka' });
    writer.insert('person', { id: 'P0' });
    writer.insert('family', { id: 'F1', partner1_id: 'P0' });
    writer.insert('family', { id: 'F2' });
    writer.insert('family_child', { family_id: 'F2', child_id: 'P1', child_order: 1 });
    writer.insert('family_child', { family_id: 'F1', child_id: 'P1', child_order: 0 });
    const counts = writer.commit();
    expect(counts).toMatchObject({ person: 2, person_name: 2, family_child: 2 });
    expect(
      store.db
        .prepare('SELECT family_id, is_preferred FROM family_child ORDER BY child_order')
        .all(),
    ).toEqual([
      { family_id: 'F1', is_preferred: 1 },
      { family_id: 'F2', is_preferred: 0 },
    ]);
    expect(names.list(store, 'P1').map((x) => [x.given, x.is_primary])).toEqual([
      ['Alder', 1],
      ['Al', 0],
    ]);
    expect(searchPeople(store, 'alder').map((r) => r.person.id)).toEqual(['P1']);

    const bad = new BulkWriter(store);
    bad.insert('person', { id: 'P2' });
    bad.insert('person_name', { person_id: 'MISSING' });
    expect(() => bad.commit()).toThrow(/FOREIGN KEY/);
    expect(store.db.inTransaction).toBe(false);
    expect(store.db.prepare("SELECT 1 FROM person WHERE id = 'P2'").get()).toBeUndefined();

    const aborted = new BulkWriter(store);
    aborted.insert('person', { id: 'P3' });
    aborted.rollback();
    expect(store.db.prepare("SELECT 1 FROM person WHERE id = 'P3'").get()).toBeUndefined();
    expect(() => aborted.insert('person', {})).toThrow(/finished/);
    store.close();
  });

  it('only writes data tables and known columns', () => {
    const store = memoryTree();
    const writer = new BulkWriter(store);
    expect(() => writer.insert('change_log' as 'person', {})).toThrow(/not allowed/);
    expect(() => writer.insertAny('sqlite_schema', {})).toThrow(/not allowed/);
    expect(() => writer.insert('person', { 'id) VALUES (1); --': 'x' } as never)).toThrow(
      /Unknown column/,
    );
    writer.rollback();
    store.close();
  });

  it('refuses to run inside another transaction', () => {
    const store = memoryTree();
    expect(() => store.transact('x', () => new BulkWriter(store))).toThrow(/transaction/);
    store.close();
  });
});
