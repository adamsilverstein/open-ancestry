import { Tx, type TreeStore } from './store';
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
 * Parses and checks one before/after image from change_log, which may come
 * from an imported (untrusted) file: it must be a flat object with exactly the
 * table's columns, scalar values, and the key of the row it is logged for.
 * Column names from the data are never used to build SQL.
 */
export function parseLogImage(
  store: TreeStore,
  entity: string,
  entityId: string,
  json: string | null,
): Record<string, unknown> | null {
  if (!REPLAYABLE_TABLES.has(entity)) throw new Error(`Cannot replay ${entity} rows`);
  if (json === null) return null;
  const invalid = (why: string) =>
    new Error(`Invalid change_log image for ${entity} ${entityId}: ${why}`);
  let image: unknown;
  try {
    image = JSON.parse(json);
  } catch {
    throw invalid('not JSON');
  }
  if (typeof image !== 'object' || image === null || Array.isArray(image))
    throw invalid('not an object');
  const { key, columns } = store.plan(entity);
  const keys = Object.keys(image);
  if (keys.length !== columns.length || keys.some((k, i) => k !== columns[i])) {
    throw invalid('columns do not match the table');
  }
  for (const value of Object.values(image)) {
    const ok =
      value === null ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value));
    if (!ok) throw invalid('values must be strings, finite numbers or null');
  }
  if ((image as Record<string, unknown>)[key] !== entityId)
    throw invalid('key does not match entity_id');
  return image as Record<string, unknown>;
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
      // Validates the entity against the allowlist and both images before any SQL is built.
      parseLogImage(store, entry.entity, entry.entity_id, from);
      const target = parseLogImage(store, entry.entity, entry.entity_id, to);
      const { key } = store.plan(entry.entity);
      const current = store
        .stmt(`SELECT * FROM ${entry.entity} WHERE ${key} = ?`)
        .get(entry.entity_id);
      const currentJson = current === undefined ? null : JSON.stringify(current);
      if (currentJson !== from) {
        throw new UndoConflictError(
          `Cannot ${direction} "${batch.label}": ${entry.entity} ${entry.entity_id} was changed by a later edit`,
        );
      }
      tx.restore(entry.entity, entry.entity_id, target);
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
    .stmt("SELECT id FROM change_batch WHERE state = 'applied' ORDER BY id DESC LIMIT 1")
    .get() as { id: string } | undefined;
  return row ? undo(store, row.id) : null;
}

/** Redoes the oldest undone batch, i.e. the last one undone. Returns null when there is nothing to redo. */
export function redoLast(store: TreeStore): ChangeBatchRow | null {
  const row = store
    .stmt("SELECT id FROM change_batch WHERE state = 'undone' ORDER BY id ASC LIMIT 1")
    .get() as { id: string } | undefined;
  return row ? redo(store, row.id) : null;
}

/** Recent batches, newest first, for a history panel. */
export function listBatches(
  store: TreeStore,
  { limit = 50 }: { limit?: number } = {},
): ChangeBatchRow[] {
  return store
    .stmt('SELECT * FROM change_batch ORDER BY id DESC LIMIT ?')
    .all(limit) as ChangeBatchRow[];
}
