import type { Database } from 'better-sqlite3';
import v001 from './v001-initial';
import v002 from './v002-history-order';
import * as v003 from './v003-nfc-text';
import v004 from './v004-person-alias';

/** How a migration changed one table's columns, so rows written before it can be upgraded. */
export interface ColumnChanges {
  /** New columns and the value existing rows get (the column's DEFAULT). */
  added?: Record<string, unknown>;
  dropped?: string[];
  /** Old name -> new name. */
  renamed?: Record<string, string>;
}

/** Rows by table, as in the JSON interchange format. */
export type TableRowsByName = Record<string, Record<string, unknown>[]>;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * Data step in JS, run after `sql` in the same transaction: for rewrites SQL
   * cannot express (Unicode normalization). Pair it with `upgradeRow`.
   */
  run?: (db: Database) => void;
  /**
   * Column changes per table. Undo upgrades change_log images recorded under
   * older versions through these, and JSON import upgrades older backups.
   */
  columns?: Record<string, ColumnChanges>;
  /**
   * For changes a column map cannot express (values computed from other
   * rows): applied to an older JSON document's tables after `columns`.
   */
  upgradeTables?: (tables: TableRowsByName) => void;
  /**
   * For migrations that rewrite existing values (a normalization pass, a
   * format change): the same rewrite for one row written before this
   * migration. Applied after `columns` to older change_log images and JSON
   * rows, so undo still matches the live rows. Return the row unchanged for
   * tables it does not touch.
   */
  upgradeRow?: (table: string, row: Record<string, unknown>) => Record<string, unknown>;
}

/** v2: number existing batches by commit order, mirroring the SQL backfill. */
function numberBatches(tables: TableRowsByName): void {
  const batches = tables.change_batch;
  if (!batches) return;
  const first = new Map<unknown, number>();
  for (const entry of tables.change_log ?? []) {
    const seq = entry.seq;
    if (typeof seq !== 'number') continue;
    const known = first.get(entry.batch_id);
    if (known === undefined || seq < known) first.set(entry.batch_id, seq);
  }
  const key = (b: Record<string, unknown>) => first.get(b.id) ?? Infinity;
  [...batches]
    .sort((a, b) => key(a) - key(b) || (String(a.id) < String(b.id) ? -1 : 1))
    .forEach((batch, i) => (batch.seq = i + 1));
}

/**
 * Forward-only migrations. To change the schema, append a migration with its
 * column map, freeze history/schema-vN.sql and history/oa-vN.json, and update
 * docs/data-model.md ("Versioning policy" has the checklist).
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: v001 },
  {
    version: 2,
    name: 'history-order',
    sql: v002,
    columns: { change_batch: { added: { seq: 0 } }, change_log: { added: { schema_version: 1 } } },
    upgradeTables: numberBatches,
  },
  {
    version: 3,
    name: 'nfc-text',
    sql: '',
    run: v003.normalizeText,
    upgradeRow: v003.upgradeRow,
    upgradeTables: v003.upgradeTables,
  },
  // A new table: no column map; importing an older backup gives it an empty list.
  { version: 4, name: 'person-alias', sql: v004 },
];

/**
 * Upgrades one row written under `fromVersion` through every later
 * migration: its column map, then its `upgradeRow`. Never changes the input.
 */
export function upgradeRow(
  migrations: readonly Migration[],
  fromVersion: number,
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  let out = row;
  for (const migration of migrations) {
    if (migration.version <= fromVersion) continue;
    const changes = migration.columns?.[table];
    out = applyColumns(out, changes);
    if (migration.upgradeRow) out = migration.upgradeRow(table, out);
  }
  return out;
}

/** One migration's column map applied to a row; returns a copy when anything applies. */
function applyColumns(
  row: Record<string, unknown>,
  changes: ColumnChanges | undefined,
): Record<string, unknown> {
  if (!changes) return row;
  const out = { ...row };
  for (const [from, to] of Object.entries(changes.renamed ?? {})) {
    if (Object.hasOwn(out, from)) {
      out[to] = out[from];
      delete out[from];
    }
  }
  for (const column of changes.dropped ?? []) delete out[column];
  for (const [column, value] of Object.entries(changes.added ?? {})) {
    if (!Object.hasOwn(out, column)) out[column] = value;
  }
  return out;
}

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
      migration.run?.(db);
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
