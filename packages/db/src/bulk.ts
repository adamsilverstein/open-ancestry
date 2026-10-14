import { rebuildSearchIndex } from './search';
import type { TreeStore } from './store';
import { DATA_TABLES, HISTORY_TABLES, assertDataTable } from './tables';
import type { InsertRow, TableName } from './types';

/** Rows to load, by table. */
export type BulkData = { [T in TableName]?: InsertRow<T>[] };

export type BulkCounts = Partial<Record<string, number>>;

/** Load order (parents first); deferred foreign keys make it a nicety, not a requirement. */
export const BULK_TABLE_ORDER = DATA_TABLES;

/**
 * Fast loader for the importer: one open transaction, cached prepared
 * statements, no change_log rows, and a single search index rebuild at commit.
 * An import into a new tree is undone by deleting the tree, not row by row.
 *
 * ```ts
 * const writer = new BulkWriter(store);
 * for (const record of parsed) writer.insert('person', toPersonRow(record));
 * writer.commit();
 * ```
 */
export interface BulkWriterOptions {
  /**
   * The target is a new, empty tree (an import). Secondary indexes are
   * dropped and rebuilt once at commit, foreign keys are checked once at
   * commit instead of row by row, and the page cache is enlarged for the
   * load. The schema and these pragmas are restored whether the load commits
   * or rolls back. On a 100k-person import this cuts database time by about
   * a third (#117).
   */
  freshTree?: boolean;
}

/** Page cache for a fresh-tree load, in KiB (512 MiB; only pages actually used count). */
const FRESH_TREE_CACHE_KIB = 512 * 1024;

interface Inserter {
  table: string;
  keyIndex: number;
}

export class BulkWriter {
  private readonly store: TreeStore;
  private readonly now: string;
  private readonly counts: Record<string, number> = {};
  private readonly inserters = new Map<string, Inserter>();
  /** Tables already checked by `insert` (history tables are only for `insertAny`). */
  private readonly dataTables = new Set<string>();
  private open = true;
  /** Pragmas to put back, when this load changed them. */
  private restore?: { foreignKeys: unknown; cacheSize: unknown };
  /** Secondary indexes dropped for the load, rebuilt at commit. */
  private deferred: { name: string; sql: string }[] = [];

  constructor(store: TreeStore, { freshTree = false }: BulkWriterOptions = {}) {
    if (store.db.inTransaction) throw new Error('BulkWriter cannot run inside another transaction');
    this.store = store;
    this.now = store.clock();
    if (freshTree) {
      for (const table of DATA_TABLES) {
        if (table !== 'meta' && store.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
          throw new Error('A fresh-tree bulk load needs an empty tree');
        }
      }
      // Both pragmas are per connection and must change outside a transaction.
      this.restore = {
        foreignKeys: store.db.pragma('foreign_keys', { simple: true }),
        cacheSize: store.db.pragma('cache_size', { simple: true }),
      };
      store.db.pragma('foreign_keys = OFF');
      store.db.pragma(`cache_size = -${FRESH_TREE_CACHE_KIB}`);
    }
    store.db.exec('BEGIN');
    if (freshTree) {
      this.deferred = store.db
        .prepare(
          `SELECT name, sql FROM sqlite_schema
           WHERE type = 'index' AND sql IS NOT NULL AND sql NOT LIKE 'CREATE UNIQUE%'
             AND tbl_name IN (SELECT value FROM json_each(?))
           ORDER BY name`,
        )
        .all(JSON.stringify(DATA_TABLES)) as { name: string; sql: string }[];
      // DDL is transactional: a rollback brings the indexes back.
      for (const { name } of this.deferred) store.db.exec(`DROP INDEX ${name}`);
    }
  }

  /** Inserts a row (defaults filled like `Tx.insert`) and returns its key. */
  insert<T extends TableName>(table: T, row: InsertRow<T>): string {
    if (!this.dataTables.has(table)) {
      assertDataTable(table);
      this.dataTables.add(table);
    }
    return this.insertAny(table, row as Record<string, unknown>);
  }

  /** Untyped insert, also used for change history tables by the JSON importer. */
  insertAny(table: string, input: Record<string, unknown>): string {
    if (!this.open) throw new Error('BulkWriter already finished');
    let inserter = this.inserters.get(table);
    if (!inserter) {
      if (!HISTORY_TABLES.includes(table)) assertDataTable(table);
      const { key, columns } = this.store.plan(table);
      inserter = { table, keyIndex: columns.indexOf(key) };
      this.inserters.set(table, inserter);
    }
    const values = this.store.rowValues(table, input, this.now);
    this.store.insertStatement(table).run(values);
    this.counts[table] = (this.counts[table] ?? 0) + 1;
    return values[inserter.keyIndex] as string;
  }

  /**
   * Rebuilds deferred indexes and checks foreign keys (fresh-tree loads),
   * fixes up primary names, rebuilds search, and commits. Rolls back on any
   * failure.
   */
  commit(): BulkCounts {
    if (!this.open) throw new Error('BulkWriter already finished');
    this.open = false;
    try {
      for (const { sql } of this.deferred) this.store.db.exec(sql);
      if (this.restore) {
        const broken = this.store.db.prepare('PRAGMA foreign_key_check').get() as
          { table: string; rowid: number; parent: string } | undefined;
        if (broken) {
          throw new Error(
            `FOREIGN KEY constraint failed: ${broken.table} row ${broken.rowid} references a missing ${broken.parent}`,
          );
        }
      }
      // Every person with names gets exactly one primary: the first by sort_order.
      this.store.db.exec(`
        UPDATE person_name SET is_primary = 1 WHERE id IN (
          SELECT (SELECT m.id FROM person_name m WHERE m.person_id = n.person_id ORDER BY m.sort_order, m.id LIMIT 1)
          FROM person_name n GROUP BY n.person_id HAVING max(n.is_primary) = 0)`);
      // Likewise every child gets exactly one preferred parent family.
      this.store.db.exec(`
        UPDATE family_child SET is_preferred = 1 WHERE id IN (
          SELECT (SELECT m.id FROM family_child m WHERE m.child_id = c.child_id ORDER BY m.child_order, m.id LIMIT 1)
          FROM family_child c GROUP BY c.child_id HAVING max(c.is_preferred) = 0)`);
      rebuildSearchIndex(this.store);
      this.store.db.exec('COMMIT');
    } catch (error) {
      if (this.store.db.inTransaction) this.store.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.restorePragmas();
    }
    return { ...this.counts };
  }

  rollback(): void {
    if (!this.open) return;
    this.open = false;
    try {
      this.store.db.exec('ROLLBACK');
    } finally {
      this.restorePragmas();
    }
  }

  private restorePragmas(): void {
    if (!this.restore) return;
    this.store.db.pragma(`cache_size = ${Number(this.restore.cacheSize)}`);
    this.store.db.pragma(`foreign_keys = ${this.restore.foreignKeys ? 'ON' : 'OFF'}`);
    this.restore = undefined;
  }
}

/** Loads a whole data set in one transaction. Returns row counts per table. */
export function bulkInsert(
  store: TreeStore,
  data: BulkData,
  options: BulkWriterOptions = {},
): BulkCounts {
  const writer = new BulkWriter(store, options);
  try {
    for (const table of BULK_TABLE_ORDER) {
      for (const row of data[table] ?? []) writer.insert(table, row as never);
    }
  } catch (error) {
    writer.rollback();
    throw error;
  }
  return writer.commit();
}
