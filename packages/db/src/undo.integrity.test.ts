import { describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  exportJson,
  getSchemaVersion,
  importJson,
  migrate,
  openMemoryTree,
  persons,
  undoLast,
} from './index';

describe('adversarial: undo of history from an imported JSON backup', () => {
  it('never lets a change_log entry rewrite schema_version', () => {
    const source = openMemoryTree();
    source.transact('add', (tx) => persons.create(tx, { names: [{ given: 'Ida', surname: 'Wren' }] }));
    const doc = exportJson(source);
    source.close();
    const current = String(LATEST_SCHEMA_VERSION);
    // A crafted (or corrupted) backup: its newest batch "changed" schema_version.
    doc.tables.change_batch!.push({
      id: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ',
      label: 'Looks harmless',
      state: 'applied',
      created_at: '2026-01-01T00:00:00.000Z',
      state_changed_at: null,
      seq: 999,
    } as never);
    doc.tables.change_log!.push({
      seq: 999,
      batch_id: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ',
      ts: '2026-01-01T00:00:00.000Z',
      entity: 'meta',
      entity_id: 'schema_version',
      op: 'update',
      before_json: JSON.stringify({ key: 'schema_version', value: '99' }),
      after_json: JSON.stringify({ key: 'schema_version', value: current }),
      schema_version: LATEST_SCHEMA_VERSION,
    } as never);
    const store = openMemoryTree();
    // Either the import refuses the entry, or undo does; the tree must stay openable.
    try {
      importJson(store, doc);
      undoLast(store);
    } catch {
      // refused: fine
    }
    expect(getSchemaVersion(store.db)).toBe(LATEST_SCHEMA_VERSION);
    expect(() => migrate(store.db)).not.toThrow();
    store.close();
  });
});
