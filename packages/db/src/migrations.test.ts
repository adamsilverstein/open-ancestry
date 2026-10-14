import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  dumpSchema,
  getSchemaVersion,
  migrate,
  openMemoryTree,
} from './index';

const historyDir = join(import.meta.dirname, 'migrations', 'history');

/** Frozen `schema-vN.sql` dumps: the exact schema every released version produced. */
function historicalVersions(): number[] {
  return readdirSync(historyDir)
    .map((f) => /^schema-v(\d+)\.sql$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

function freshSchema(): string {
  const db = new Database(':memory:');
  migrate(db);
  const schema = dumpSchema(db);
  db.close();
  return schema;
}

describe('migrations', () => {
  it('are numbered 1..N without gaps', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(
      Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1),
    );
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  it('records schema_version in meta', () => {
    const store = openMemoryTree();
    expect(getSchemaVersion(store.db)).toBe(LATEST_SCHEMA_VERSION);
    const row = store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(row.value).toBe(String(LATEST_SCHEMA_VERSION));
    store.close();
  });

  it('reports version 0 for an empty database', () => {
    const db = new Database(':memory:');
    expect(getSchemaVersion(db)).toBe(0);
    db.close();
  });

  it('has a frozen schema dump for every released version', () => {
    expect(historicalVersions()).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it.each(MIGRATIONS.map((m) => m.version))(
    'migration %i produces exactly its frozen schema (migrations are never edited)',
    (version) => {
      const db = new Database(':memory:');
      migrate(db, { to: version });
      expect(getSchemaVersion(db)).toBe(version);
      expect(dumpSchema(db)).toBe(
        readFileSync(join(historyDir, `schema-v${version}.sql`), 'utf8').trim(),
      );
      db.close();
    },
  );

  it.each([0, ...MIGRATIONS.map((m) => m.version)])(
    'upgrades a database at version %i to the latest schema',
    (version) => {
      const db = new Database(':memory:');
      if (version > 0) {
        db.exec(readFileSync(join(historyDir, `schema-v${version}.sql`), 'utf8'));
        db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(
          String(version),
        );
      }
      const applied = migrate(db);
      expect(applied).toEqual(MIGRATIONS.filter((m) => m.version > version).map((m) => m.version));
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(dumpSchema(db)).toBe(freshSchema());
      db.close();
    },
  );

  it('is idempotent', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(migrate(db)).toEqual([]);
    db.close();
  });

  it('refuses to open a database written by a newer version', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
      String(LATEST_SCHEMA_VERSION + 1),
    );
    expect(() => migrate(db)).toThrow(/newer/);
    db.close();
  });

  it('refuses to migrate backwards', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(() => migrate(db, { to: 0 })).toThrow(/forward-only/);
    db.close();
  });

  it('rolls back a failing migration as a unit', () => {
    const db = new Database(':memory:');
    const broken = [
      { version: 1, name: 'ok', sql: 'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)' },
      { version: 2, name: 'broken', sql: 'CREATE TABLE a (x); SELECT * FROM missing_table' },
    ];
    expect(() => migrate(db, { migrations: broken })).toThrow();
    expect(getSchemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'a'").get()).toBeUndefined();
    db.close();
  });
});
