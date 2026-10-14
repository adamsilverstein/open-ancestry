import type { Database } from 'better-sqlite3';
import v001 from './v001-initial';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Forward-only migrations. To change the schema, append a migration, add its
 * frozen dump as history/schema-vN.sql, and update docs/data-model.md.
 */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'initial', sql: v001 }];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

export function getSchemaVersion(db: Database): number {
  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'meta'")
    .get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export interface MigrateOptions {
  /** Stop at this version (tests use it to build historical databases). */
  to?: number;
  migrations?: readonly Migration[];
}

/** Applies pending migrations, each in its own transaction. Returns the versions applied. */
export function migrate(db: Database, options: MigrateOptions = {}): number[] {
  const migrations = options.migrations ?? MIGRATIONS;
  const latest = migrations.length;
  const target = options.to ?? latest;
  const current = getSchemaVersion(db);
  if (current > latest) {
    throw new Error(
      `Database schema version ${current} is newer than this app supports (${latest}); upgrade open-ancestry.`,
    );
  }
  if (target < current) {
    throw new Error(`Migrations are forward-only: database is at ${current}, asked for ${target}.`);
  }
  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= current || migration.version > target) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(String(migration.version));
    })();
    applied.push(migration.version);
  }
  return applied;
}

export interface TableInfo {
  name: string;
  columns: string[];
  virtual: boolean;
}

/** User-visible tables and their columns in declaration order (FTS shadow tables excluded). */
export function listTables(db: Database): TableInfo[] {
  const tables = db
    .prepare(
      "SELECT name, type FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string; type: string }[];
  return tables.map(({ name, type }) => ({
    name,
    virtual: type === 'virtual',
    columns: (
      db.prepare('SELECT name FROM pragma_table_info(?)').all(name) as { name: string }[]
    ).map((c) => c.name),
  }));
}

/**
 * The schema as executable SQL in a stable order: tables, then indexes, then
 * views and triggers. Used for frozen history files and upgrade comparisons.
 */
export function dumpSchema(db: Database): string {
  const shadow = new Set(
    (
      db.prepare("SELECT name FROM pragma_table_list WHERE type = 'shadow'").all() as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`,
    )
    .all() as { name: string; sql: string }[];
  return rows
    .filter((r) => !shadow.has(r.name))
    .map((r) => `${r.sql};`)
    .join('\n\n');
}
