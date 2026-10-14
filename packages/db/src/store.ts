import type { Database, Statement } from 'better-sqlite3';
import { MIGRATIONS, migrate, type Migration } from './migrations/index';
import { markSearchDirty, refreshSearch } from './search';
import { assertDataTable } from './tables';
import type { InsertRow, PatchRow, TableName, TableRows } from './types';
import { ulid } from './ulid';

/**
 * A write was attempted while the connection already has a transaction open,
 * such as an import's: SQLite would nest it as a savepoint inside that
 * transaction, so its fate would follow the other writer's.
 */
export class TransactionInProgressError extends Error {
  constructor() {
    super('nested transactions are not supported');
    this.name = 'TransactionInProgressError';
  }
}

export class NotFoundError extends Error {
  constructor(table: string, id: string) {
    super(`${table} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export interface TablePlan {
  key: string;
  columns: string[];
  /** Column defaults from the DDL, already converted to JS values. */
  defaults: Record<string, unknown>;
  hasUpdatedAt: boolean;
  columnSet: ReadonlySet<string>;
  /** Per column: how to fill it when the input leaves it out. */
  fill: readonly ('id' | 'now' | 'default')[];
  defaultValues: readonly unknown[];
  /** NOT NULL columns without a DEFAULT: a row image must supply them. */
  required: ReadonlySet<string>;
  insert?: Statement;
}

export interface StoreOptions {
  /** ISO-8601 timestamp source; injectable for deterministic tests. */
  clock?: () => string;
  newId?: () => string;
  /** How long to wait for another connection's lock before SQLITE_BUSY (default 5000ms). */
  busyTimeoutMs?: number;
  /**
   * The migration chain to apply (default MIGRATIONS). Tests pass a longer
   * chain to simulate a future schema version.
   */
  migrations?: readonly Migration[];
  /** Maintenance messages, such as derived columns being recomputed (default console.info). */
  log?: (message: string) => void;
}

const TIMESTAMP_COLUMNS = new Set(['created_at', 'updated_at', 'started_at']);

/** Parses a PRAGMA table_info dflt_value (an SQL literal) into a JS value. */
function parseDefault(literal: string | null): unknown {
  if (literal === null || literal.toUpperCase() === 'NULL') return null;
  if (literal.startsWith("'")) return literal.slice(1, -1).replaceAll("''", "'");
  return Number(literal);
}

/** An open tree database: connection, statement cache, and the unit of work. */
export class TreeStore {
  readonly db: Database;
  readonly dir: string | null;
  readonly clock: () => string;
  readonly newId: () => string;
  readonly migrations: readonly Migration[];
  /** The schema version this store migrated to and writes change_log images under. */
  readonly schemaVersion: number;
  readonly log: (message: string) => void;
  private readonly statements = new Map<string, Statement>();
  private readonly plans = new Map<string, TablePlan>();

  constructor(db: Database, dir: string | null, options: StoreOptions = {}) {
    this.db = db;
    this.dir = dir;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.newId = options.newId ?? ulid;
    db.pragma('foreign_keys = ON');
    if (dir !== null) {
      db.pragma('journal_mode = WAL');
      db.pragma('mmap_size = 268435456');
    }
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -65536');
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
    this.log = options.log ?? ((message) => console.info(message));
    this.migrations = options.migrations ?? MIGRATIONS;
    this.schemaVersion = this.migrations.length;
    migrate(db, { migrations: this.migrations });
  }

  /** Cached prepared statement. */
  stmt(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  plan(table: string): TablePlan {
    let plan = this.plans.get(table);
    if (!plan) {
      const info = this.db
        .prepare('SELECT name, dflt_value, pk, "notnull" FROM pragma_table_info(?)')
        .all(table) as {
        name: string;
        dflt_value: string | null;
        pk: number;
        notnull: number;
      }[];
      if (info.length === 0) throw new Error(`Unknown table ${table}`);
      const key = info.find((c) => c.pk === 1)?.name ?? 'id';
      const columns = info.map((c) => c.name);
      plan = {
        key,
        columns,
        defaults: Object.fromEntries(info.map((c) => [c.name, parseDefault(c.dflt_value)])),
        hasUpdatedAt: columns.includes('updated_at'),
        columnSet: new Set(columns),
        fill: columns.map((c) =>
          c === key && c === 'id' ? 'id' : TIMESTAMP_COLUMNS.has(c) ? 'now' : 'default',
        ),
        defaultValues: info.map((c) => parseDefault(c.dflt_value)),
        required: new Set(
          info
            .filter((c) => (c.notnull || c.pk) && parseDefault(c.dflt_value) === null)
            .map((c) => c.name),
        ),
      };
      this.plans.set(table, plan);
    }
    return plan;
  }

  getRow<T extends TableName>(table: T, id: string): TableRows[T] | undefined {
    assertDataTable(table);
    const { key } = this.plan(table);
    return this.stmt(`SELECT * FROM ${table} WHERE ${key} = ?`).get(id) as TableRows[T] | undefined;
  }

  /**
   * Column values (in table order) for a partial input: ids, timestamps and
   * DDL defaults filled in. Unknown input keys are refused. This is the bulk
   * loader's hot path, so it works on arrays and cached plan data.
   */
  rowValues(table: string, input: Record<string, unknown>, now: string): unknown[] {
    const plan = this.plan(table);
    for (const column in input) {
      if (!plan.columnSet.has(column)) throw new Error(`Unknown column ${table}.${column}`);
    }
    const { columns, fill, defaultValues } = plan;
    const values = new Array<unknown>(columns.length);
    for (let i = 0; i < columns.length; i++) {
      const value = input[columns[i] as string];
      if (value !== undefined) values[i] = value;
      else if (fill[i] === 'id') values[i] = this.newId();
      else if (fill[i] === 'now') values[i] = now;
      else values[i] = defaultValues[i];
    }
    return values;
  }

  /** Like `rowValues`, as an object keyed by column. */
  completeRow(table: string, input: Record<string, unknown>, now: string): Record<string, unknown> {
    const values = this.rowValues(table, input, now);
    const row: Record<string, unknown> = {};
    this.plan(table).columns.forEach((column, i) => (row[column] = values[i]));
    return row;
  }

  insertStatement(table: string): Statement {
    const plan = this.plan(table);
    plan.insert ??= this.db.prepare(
      `INSERT INTO ${table} (${plan.columns.join(', ')}) VALUES (${plan.columns.map(() => '?').join(', ')})`,
    );
    return plan.insert;
  }

  /**
   * Runs `fn` as one unit of work: a single SQLite transaction whose writes are
   * all recorded in change_log under a new change_batch, so it can be undone.
   */
  transact<R>(label: string, fn: (tx: Tx) => R): { batchId: string; result: R } {
    if (this.db.inTransaction) throw new TransactionInProgressError();
    const batchId = this.newId();
    const now = this.clock();
    const tx = new Tx(this, batchId, now, true);
    const run = this.db.transaction(() => {
      // seq is max + 1 inside this write transaction: commit order, whatever the clock says.
      this.stmt(
        `INSERT INTO change_batch (id, label, state, created_at, seq)
         VALUES (?, ?, ?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM change_batch))`,
      ).run(batchId, label, 'applied', now);
      const result = fn(tx);
      tx.flush();
      if (tx.changes === 0) {
        this.stmt('DELETE FROM change_batch WHERE id = ?').run(batchId);
      } else {
        // A new edit invalidates the redo stack.
        this.stmt(
          "UPDATE change_batch SET state = 'superseded', state_changed_at = ? WHERE state = 'undone'",
        ).run(now);
      }
      return result;
    });
    try {
      return { batchId, result: run() };
    } finally {
      // A deferred foreign key failure at COMMIT leaves the transaction open.
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Write handle passed to `TreeStore.transact`. Every insert, update and delete
 * goes through here so it is change-logged and keeps the search index fresh.
 */
export class Tx {
  readonly store: TreeStore;
  readonly batchId: string;
  readonly now: string;
  changes = 0;
  private readonly logging: boolean;
  private readonly dirty = new Set<string>();

  constructor(store: TreeStore, batchId: string, now: string, logging: boolean) {
    this.store = store;
    this.batchId = batchId;
    this.now = now;
    this.logging = logging;
  }

  insert<T extends TableName>(table: T, input: InsertRow<T>): TableRows[T] {
    assertDataTable(table);
    const row = this.store.completeRow(table, input as Record<string, unknown>, this.now);
    this.store.insertStatement(table).run(Object.values(row));
    this.record(table, null, row);
    return row as unknown as TableRows[T];
  }

  update<T extends TableName>(table: T, id: string, patch: PatchRow<T>): TableRows[T] {
    assertDataTable(table);
    const plan = this.store.plan(table);
    for (const column of Object.keys(patch)) {
      if (!plan.columns.includes(column)) throw new Error(`Unknown column ${table}.${column}`);
      if (column === plan.key) throw new Error(`Cannot change the key of ${table} rows`);
    }
    const before = this.store.getRow(table, id) as Record<string, unknown> | undefined;
    if (!before) throw new NotFoundError(table, id);
    const changed = Object.entries(patch).filter(
      ([column, value]) => value !== undefined && before[column] !== value,
    );
    if (changed.length === 0) return before as unknown as TableRows[T];
    const patchValues = Object.fromEntries(changed);
    const after: Record<string, unknown> = { ...before, ...patchValues };
    if (plan.hasUpdatedAt && !('updated_at' in patchValues)) after.updated_at = this.now;
    this.writeRow(table, after);
    this.record(table, before, after);
    return after as unknown as TableRows[T];
  }

  delete<T extends TableName>(table: T, id: string): TableRows[T] {
    assertDataTable(table);
    const before = this.store.getRow(table, id);
    if (!before) throw new NotFoundError(table, id);
    const { key } = this.store.plan(table);
    this.store.stmt(`DELETE FROM ${table} WHERE ${key} = ?`).run(id);
    this.record(table, before as unknown as Record<string, unknown>, null);
    return before;
  }

  /**
   * Puts a row back to `target` (or removes it when null), without logging.
   * Used by undo/redo to replay before/after images.
   */
  restore(table: string, id: string, target: Record<string, unknown> | null): void {
    const { key } = this.store.plan(table);
    const current = this.store.stmt(`SELECT * FROM ${table} WHERE ${key} = ?`).get(id) as
      Record<string, unknown> | undefined;
    if (target === null) {
      if (current) this.store.stmt(`DELETE FROM ${table} WHERE ${key} = ?`).run(id);
    } else if (current) {
      this.writeRow(table, { ...target, [key]: id });
    } else {
      this.store.insertStatement(table).run(this.store.plan(table).columns.map((c) => target[c]));
    }
    this.record(table, current ?? null, target);
  }

  private writeRow(table: string, row: Record<string, unknown>): void {
    const { key, columns } = this.store.plan(table);
    const assignments = columns.filter((c) => c !== key);
    this.store
      .stmt(`UPDATE ${table} SET ${assignments.map((c) => `${c} = ?`).join(', ')} WHERE ${key} = ?`)
      .run([...assignments.map((c) => row[c]), row[key]]);
  }

  private record(
    table: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): void {
    this.changes++;
    markSearchDirty(this.store, this.dirty, table, before, after);
    if (!this.logging) return;
    const { key } = this.store.plan(table);
    this.store
      .stmt(
        'INSERT INTO change_log (batch_id, ts, entity, entity_id, op, before_json, after_json, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.batchId,
        this.now,
        table,
        (after ?? before)?.[key],
        before === null ? 'insert' : after === null ? 'delete' : 'update',
        before === null ? null : JSON.stringify(before),
        after === null ? null : JSON.stringify(after),
        this.store.schemaVersion,
      );
  }

  /** Re-indexes people touched by this unit of work. */
  flush(): void {
    refreshSearch(this.store, [...this.dirty]);
    this.dirty.clear();
  }
}
