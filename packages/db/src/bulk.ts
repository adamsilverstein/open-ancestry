import type { Statement } from 'better-sqlite3';
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
  /**
   * With `freshTree`: this connection is the only one that has the file open
   * (the importer created the tree), so the load can switch from WAL to a
   * rollback journal, which writes each new page once instead of twice.
   * Switching while another connection has the file open would lock it out,
   * so an import worker writing into a tree the server has open (its Library
   * keeps its own connections) must leave this unset.
   */
  soleConnection?: boolean;
}

/** Page cache for a fresh-tree load, in KiB (256 MiB; only pages actually used count). */
const FRESH_TREE_CACHE_KIB = 256 * 1024;

/** Rows per multi-row INSERT. */
const BATCH_ROWS = 32;

interface Inserter {
  table: string;
  keyIndex: number;
  columns: number;
  /** Column values of rows not yet written, flattened. */
  pending: unknown[];
  rows: number;
  /** INSERT of exactly BATCH_ROWS rows. */
  batch: Statement;
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
  private restore?: { foreignKeys: unknown; cacheSize: unknown; wal: boolean };
  /** Secondary indexes dropped for the load, rebuilt at commit. */
  private deferred: { name: string; sql: string }[] = [];

  constructor(
    store: TreeStore,
    { freshTree = false, soleConnection = false }: BulkWriterOptions = {},
  ) {
    if (store.db.inTransaction) throw new Error('BulkWriter cannot run inside another transaction');
    this.store = store;
    this.now = store.clock();
    if (freshTree) {
      for (const table of [...DATA_TABLES, ...HISTORY_TABLES]) {
        if (table !== 'meta' && store.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
          throw new Error('A fresh-tree bulk load needs an empty tree');
        }
      }
      // Both pragmas are per connection and must change outside a transaction.
      this.restore = {
        foreignKeys: store.db.pragma('foreign_keys', { simple: true }),
        cacheSize: store.db.pragma('cache_size', { simple: true }),
        wal:
          soleConnection &&
          store.db.pragma('journal_mode', { simple: true }) === 'wal' &&
          store.db.pragma('journal_mode = DELETE', { simple: true }) === 'delete',
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
      inserter = {
        table,
        keyIndex: columns.indexOf(key),
        columns: columns.length,
        pending: [],
        rows: 0,
        batch: this.insertRows(table, BATCH_ROWS),
      };
      this.inserters.set(table, inserter);
    }
    const values = this.store.rowValues(table, input, this.now);
    for (const value of values) inserter.pending.push(value);
    if (++inserter.rows === BATCH_ROWS) this.write(inserter);
    this.counts[table] = (this.counts[table] ?? 0) + 1;
    return values[inserter.keyIndex] as string;
  }

  /**
   * Writes every buffered row. Rows are batched per table into multi-row
   * INSERTs, which costs a third less than one statement per row; call this
   * before reading back rows the load wrote. `commit` flushes first.
   */
  flush(): void {
    for (const inserter of this.inserters.values()) this.write(inserter);
  }

  private write(inserter: Inserter): void {
    if (inserter.rows === 0) return;
    const statement =
      inserter.rows === BATCH_ROWS
        ? inserter.batch
        : this.insertRows(inserter.table, inserter.rows);
    // Clear first: after a failed batch the load is rolled back, never retried.
    const values = inserter.pending;
    inserter.pending = [];
    inserter.rows = 0;
    statement.run(values);
  }

  private insertRows(table: string, rows: number): Statement {
    const { columns } = this.store.plan(table);
    const row = `(${columns.map(() => '?').join(', ')})`;
    return this.store.db.prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${Array(rows).fill(row).join(', ')}`,
    );
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
      this.flush();
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
    if (this.restore.wal) this.store.db.pragma('journal_mode = WAL');
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
