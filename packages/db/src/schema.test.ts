import { describe, expect, it } from 'vitest';
import {
  CHILD_RELATIONSHIPS,
  ENUM_COLUMNS,
  EVENT_ROLES,
  LIVING_STATUSES,
  families,
  isLiving,
  media,
  persons,
} from './index';
import { memoryTree } from './test/helpers';

describe('schema constraints', () => {
  it.each(Object.entries(ENUM_COLUMNS))(
    'CHECK constraint on %s matches the TypeScript enum',
    (key, values) => {
      const [table, column] = key.split('.') as [string, string];
      const store = memoryTree();
      const tableColumns = store.db.pragma(`table_info(${table})`) as { name: string }[];
      expect(tableColumns.map((c) => c.name)).toContain(column);
      // Pull the column's CHECK clause from the DDL and confirm it lists exactly these values.
      const { sql } = store.db
        .prepare('SELECT sql FROM sqlite_schema WHERE name = ?')
        .get(table) as { sql: string };
      const line = sql.split('\n').find((l) => l.trim().startsWith(`${column} `));
      expect(line, `${table}.${column} DDL line`).toBeDefined();
      const check = (line ?? '').slice((line ?? '').indexOf('CHECK'));
      const listed = [...check.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      expect(listed).toEqual([...values]);
      store.close();
    },
  );

  it('rejects values outside an enum', () => {
    const store = memoryTree();
    expect(() => store.transact('bad', (tx) => persons.create(tx, { sex: 'Q' as 'M' }))).toThrow(
      /CHECK/,
    );
    expect(() =>
      store.transact('bad', (tx) => persons.create(tx, { living: 'zombie' as 'living' })),
    ).toThrow(/CHECK/);
    store.close();
  });

  it('accepts every child relationship type for both partners', () => {
    const store = memoryTree();
    store.transact('rels', (tx) => {
      const a = persons.create(tx, {}).id;
      for (const rel of CHILD_RELATIONSHIPS) {
        const child = persons.create(tx, {}).id;
        families.create(tx, {
          partner1_id: a,
          children: [{ child_id: child, partner1_rel: rel, partner2_rel: rel }],
        });
      }
    });
    const count = store.db.prepare('SELECT count(*) AS n FROM family_child').get() as {
      n: number;
    };
    expect(count.n).toBe(CHILD_RELATIONSHIPS.length);
    expect(CHILD_RELATIONSHIPS).toEqual([
      'biological',
      'adopted',
      'step',
      'foster',
      'related',
      'guardian',
      'private',
      'unknown',
    ]);
    store.close();
  });

  it('enforces foreign keys at commit', () => {
    const store = memoryTree();
    expect(() =>
      store.transact('dangling', (tx) => tx.insert('person_name', { person_id: 'NOPE' })),
    ).toThrow(/FOREIGN KEY/);
    expect(store.db.inTransaction).toBe(false);
    expect(store.db.prepare('SELECT count(*) AS n FROM person_name').get()).toEqual({ n: 0 });
    store.close();
  });

  it('enforces one primary name per person', () => {
    const store = memoryTree();
    expect(() =>
      store.transact('two primaries', (tx) => {
        const p = persons.create(tx, {});
        tx.insert('person_name', { person_id: p.id, is_primary: 1 });
        tx.insert('person_name', { person_id: p.id, is_primary: 1 });
      }),
    ).toThrow(/UNIQUE/);
    store.close();
  });

  it('requires an event role to point at exactly one of person or family', () => {
    const store = memoryTree();
    expect(() =>
      store.transact('bad role', (tx) => {
        const e = tx.insert('event', { type: 'BIRT' });
        tx.insert('event_role', { event_id: e.id });
      }),
    ).toThrow(/CHECK/);
    store.close();
  });

  it('rejects absolute or escaping media paths', () => {
    const store = memoryTree();
    for (const local_path of [
      '/etc/passwd',
      '../x.jpg',
      'a/../../x.jpg',
      'C:\\x.jpg',
      'a\\b.jpg',
    ]) {
      expect(() => store.transact('bad path', (tx) => media.create(tx, { local_path }))).toThrow(
        /CHECK/,
      );
    }
    store.transact('ok path', (tx) => media.create(tx, { local_path: 'photos/a..b.jpg' }));
    store.close();
  });

  it('treats unknown and inferred-living people as living for privacy', () => {
    expect(LIVING_STATUSES.filter(isLiving)).toEqual(['living', 'inferred_living', 'unknown']);
  });

  it('lists the GEDCOM 7 event roles plus principal', () => {
    expect(EVENT_ROLES[0]).toBe('principal');
    expect(EVENT_ROLES).toContain('witness');
  });
});
