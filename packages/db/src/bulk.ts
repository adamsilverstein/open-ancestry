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
export class BulkWriter {
  private readonly store: TreeStore;
  private readonly now: string;
  private readonly counts: Record<string, number> = {};
  private open = true;

  constructor(store: TreeStore) {
    if (store.db.inTransaction) throw new Error('BulkWriter cannot run inside another transaction');
    this.store = store;
    this.now = store.clock();
    store.db.exec('BEGIN');
  }

  /** Inserts a row (defaults filled like `Tx.insert`) and returns its key. */
  insert<T extends TableName>(table: T, row: InsertRow<T>): string {
    assertDataTable(table);
    return this.insertAny(table, row as Record<string, unknown>);
  }

  /** Untyped insert, also used for change history tables by the JSON importer. */
  insertAny(table: string, input: Record<string, unknown>): string {
    if (!this.open) throw new Error('BulkWriter already finished');
    if (!HISTORY_TABLES.includes(table)) assertDataTable(table);
    const values = this.store.rowValues(table, input, this.now);
    this.store.insertStatement(table).run(values);
    this.counts[table] = (this.counts[table] ?? 0) + 1;
    const { key, columns } = this.store.plan(table);
    return values[columns.indexOf(key)] as string;
  }

  /** Fixes up primary names, rebuilds search, and commits (rolling back on any failure). */
  commit(): BulkCounts {
    if (!this.open) throw new Error('BulkWriter already finished');
    this.open = false;
    try {
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
    }
    return { ...this.counts };
  }

  rollback(): void {
    if (!this.open) return;
    this.open = false;
    this.store.db.exec('ROLLBACK');
  }
}

/** Loads a whole data set in one transaction. Returns row counts per table. */
export function bulkInsert(store: TreeStore, data: BulkData): BulkCounts {
  const writer = new BulkWriter(store);
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
