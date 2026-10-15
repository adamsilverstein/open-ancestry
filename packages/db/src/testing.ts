import Database from 'better-sqlite3';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS, listTables, type Migration } from './migrations/index';

/*
 * Test helpers for code that depends on schema history. Not part of the app:
 * import them from `@open-ancestry/db/testing`.
 */

/**
 * Rewrites a closed tree as the given older schema version, keeping its rows:
 * the frozen `schema-vN.sql` is created in a new file, every table's rows are
 * copied into the columns both have (columns that version lacked are left
 * out; columns it had that the tree lacks take their DEFAULT, so a column a
 * later migration renamed comes back empty), and `schema_version` is set to
 * N. Opening the tree afterwards
 * runs the real migrations from N.
 *
 * Values are copied as they are, so a migration that rewrote values (such as
 * NFC normalization) is not undone; write those values after downgrading, or
 * directly into the downgraded file.
 */
export function downgradeTree(
  dir: string,
  version: number,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const frozen = join(import.meta.dirname, 'migrations', 'history', `schema-v${version}.sql`);
  if (
    !Number.isInteger(version) ||
    version < 1 ||
    version > migrations.length ||
    !existsSync(frozen)
  ) {
    throw new Error(`No frozen schema for version ${version}`);
  }
  const path = join(dir, 'tree.sqlite');
  const next = `${path}.downgrade`;
  rmSync(next, { force: true });
  const db = new Database(next);
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(readFileSync(frozen, 'utf8'));
    db.prepare('ATTACH DATABASE ? AS src').run(path);
    const sourceColumns = (table: string) =>
      (
        db.prepare("SELECT name FROM pragma_table_info(?, 'src')").all(table) as { name: string }[]
      ).map((c) => c.name);
    db.transaction(() => {
      for (const table of listTables(db)) {
        const columns = sourceColumns(table.name).filter((c) => table.columns.includes(c));
        if (!columns.length) continue;
        // FTS rows are matched to search_doc by rowid.
        if (table.virtual) columns.unshift('rowid');
        db.exec(
          `INSERT INTO main.${table.name} (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM src.${table.name}`,
        );
      }
      db.prepare("UPDATE main.meta SET value = ? WHERE key = 'schema_version'").run(
        String(version),
      );
      if (sourceColumns('change_log').includes('schema_version') && version >= 2) {
        db.prepare('UPDATE main.change_log SET schema_version = ? WHERE schema_version > ?').run(
          version,
          version,
        );
      }
    })();
    db.exec('DETACH DATABASE src');
  } finally {
    db.close();
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  renameSync(next, path);
}
