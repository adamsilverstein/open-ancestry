import { TransactionInProgressError, Tx, type TreeStore } from './store';
import { deriveDateSort, hasConvertedDate } from './derived';
import { upgradeRow } from './migrations/index';
import { DATA_TABLES } from './tables';
import type { ChangeBatchRow, ChangeLogRow } from './types';

export class UndoConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UndoConflictError';
  }
}

/** Tables whose rows the change log may touch. Anything else in `entity` is refused. */
export const REPLAYABLE_TABLES: ReadonlySet<string> = new Set<string>(DATA_TABLES);

/**
 * Parses, upgrades and checks one before/after image from change_log, which
 * may come from an imported (untrusted) file or from an older schema version.
 *
 * - The image is upgraded from `version` (the version it was written under)
 *   through the column maps of every later migration.
 * - It is then shaped to the table's current columns: unknown keys are
 *   ignored (they never reach SQL), missing columns take their DEFAULT, and a
 *   missing NOT NULL column without a default is an error.
 * - Values must be scalars and the key must equal `entityId`.
 *
 * The result has exactly the table's columns in table order, so it can be
 * compared with `JSON.stringify` of the live row.
 */
export function parseLogImage(
  store: TreeStore,
  entity: string,
  entityId: string,
  json: string | null,
  version: number = store.schemaVersion,
): Record<string, unknown> | null {
  if (!REPLAYABLE_TABLES.has(entity)) throw new Error(`Cannot replay ${entity} rows`);
  const invalid = (why: string) =>
    new Error(`Invalid change_log image for ${entity} ${entityId}: ${why}`);
  if (!Number.isInteger(version) || version < 1) throw invalid(`bad schema version ${version}`);
  if (version > store.schemaVersion) {
    throw invalid(`written by schema version ${version}, newer than ${store.schemaVersion}`);
  }
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalid('not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw invalid('not an object');
  const image = upgradeRow(store.migrations, version, entity, parsed as Record<string, unknown>);
  const { key, columns, defaults, required } = store.plan(entity);
  const row: Record<string, unknown> = {};
  for (const column of columns) {
    if (!Object.hasOwn(image, column)) {
      if (required.has(column)) throw invalid(`missing ${column}`);
      row[column] = defaults[column];
      continue;
    }
    const value = image[column];
    const ok =
      value === null ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value));
    if (!ok) throw invalid('values must be strings, finite numbers or null');
    row[column] = value;
  }
  if (row[key] !== entityId) throw invalid('key does not match entity_id');
  return row;
}

/**
 * A row as compared by the undo conflict check. Derived sort keys of
 * calendar-converted dates are left out: they may have been recomputed since
 * the image was logged (derived.ts), which is not a later edit.
 */
function comparable(entity: string, row: unknown): string | null {
  if (row === undefined || row === null) return null;
  const record = row as Record<string, unknown>;
  if (entity === 'event' && hasConvertedDate(record)) {
    return JSON.stringify({ ...record, date_sort: null, date_sort_end: null });
  }
  return JSON.stringify(record);
}

/** Restored rows get sort keys from the current date parser, like a fresh write. */
function rederive(
  entity: string,
  row: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (entity !== 'event' || row === null || !hasConvertedDate(row)) return row;
  return { ...row, ...deriveDateSort(row.date_text) };
}

function getBatch(store: TreeStore, batchId: string): ChangeBatchRow {
  const batch = store.stmt('SELECT * FROM change_batch WHERE id = ?').get(batchId) as
    ChangeBatchRow | undefined;
  if (!batch) throw new Error(`change batch ${batchId} not found`);
  return batch;
}

/**
 * Replays a batch's log in one transaction. Each row must currently match the
 * image it is moving away from, so a batch whose rows were changed by a later
 * batch is refused instead of clobbering that later work.
 */
function replay(
  store: TreeStore,
  batch: ChangeBatchRow,
  direction: 'undo' | 'redo',
): ChangeBatchRow {
  // Inside another writer's transaction this would become a savepoint whose
  // outcome that writer decides, and the catch below would roll back its work.
  if (store.db.inTransaction) throw new TransactionInProgressError();
  const log = store
    .stmt(
      `SELECT * FROM change_log WHERE batch_id = ? ORDER BY seq ${direction === 'undo' ? 'DESC' : 'ASC'}`,
    )
    .all(batch.id) as ChangeLogRow[];
  const now = store.clock();
  const tx = new Tx(store, batch.id, now, false);
  const run = store.db.transaction(() => {
    for (const entry of log) {
      const [from, to] =
        direction === 'undo'
          ? [entry.after_json, entry.before_json]
          : [entry.before_json, entry.after_json];
      // Validates the entity against the allowlist and both images before any SQL is
      // built, upgrading images written under an older schema version.
      const expected = parseLogImage(
        store,
        entry.entity,
        entry.entity_id,
        from,
        entry.schema_version,
      );
      const target = parseLogImage(store, entry.entity, entry.entity_id, to, entry.schema_version);
      const { key } = store.plan(entry.entity);
      const current = store
        .stmt(`SELECT * FROM ${entry.entity} WHERE ${key} = ?`)
        .get(entry.entity_id);
      if (comparable(entry.entity, current) !== comparable(entry.entity, expected)) {
        throw new UndoConflictError(
          `Cannot ${direction} "${batch.label}": ${entry.entity} ${entry.entity_id} was changed by a later edit`,
        );
      }
      tx.restore(entry.entity, entry.entity_id, rederive(entry.entity, target));
    }
    tx.flush();
    store
      .stmt('UPDATE change_batch SET state = ?, state_changed_at = ? WHERE id = ?')
      .run(direction === 'undo' ? 'undone' : 'applied', now, batch.id);
  });
  try {
    run();
  } catch (error) {
    // A deferred foreign key failure at COMMIT leaves the transaction open.
    if (store.db.inTransaction) store.db.exec('ROLLBACK');
    // Rows created by this batch are still referenced by later edits (or rows
    // it deleted are needed by them): the same situation as a row conflict.
    if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw new UndoConflictError(
        `Cannot ${direction} "${batch.label}": later edits still depend on rows it ${direction === 'undo' ? 'created' : 'removed'}`,
      );
    }
    throw error;
  }
  return getBatch(store, batch.id);
}

/** Reverts a batch. It must be in the `applied` state. */
export function undo(store: TreeStore, batchId: string): ChangeBatchRow {
  const batch = getBatch(store, batchId);
  if (batch.state !== 'applied')
    throw new Error(`change batch ${batchId} is ${batch.state}, not applied`);
  return replay(store, batch, 'undo');
}

/** Re-applies an undone batch. Batches superseded by a newer edit cannot be redone. */
export function redo(store: TreeStore, batchId: string): ChangeBatchRow {
  const batch = getBatch(store, batchId);
  if (batch.state !== 'undone')
    throw new Error(`change batch ${batchId} is ${batch.state}, not undone`);
  return replay(store, batch, 'redo');
}

/** Undoes the most recent applied batch (Cmd/Ctrl-Z). Returns null when there is nothing to undo. */
export function undoLast(store: TreeStore): ChangeBatchRow | null {
  const row = store
    .stmt("SELECT id FROM change_batch WHERE state = 'applied' ORDER BY seq DESC LIMIT 1")
    .get() as { id: string } | undefined;
  return row ? undo(store, row.id) : null;
}

/** Redoes the oldest undone batch, i.e. the last one undone. Returns null when there is nothing to redo. */
export function redoLast(store: TreeStore): ChangeBatchRow | null {
  const row = store
    .stmt("SELECT id FROM change_batch WHERE state = 'undone' ORDER BY seq ASC LIMIT 1")
    .get() as { id: string } | undefined;
  return row ? redo(store, row.id) : null;
}

/** Recent batches, newest first, for a history panel. */
export function listBatches(
  store: TreeStore,
  { limit = 50 }: { limit?: number } = {},
): ChangeBatchRow[] {
  return store
    .stmt('SELECT * FROM change_batch ORDER BY seq DESC LIMIT ?')
    .all(limit) as ChangeBatchRow[];
}
