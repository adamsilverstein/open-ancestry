import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  createTree,
  dumpSchema,
  openTree,
  persons,
  undoLast,
} from './index';
import { seedSmallFamily } from './test/helpers';
import { downgradeTree } from './testing';

const historyDir = join(import.meta.dirname, 'migrations', 'history');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-downgrade-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A tree written by the current code, with data and undo history. */
function populated(): string {
  const dir = join(root, 'tree.oatree');
  const store = createTree(dir);
  seedSmallFamily(store);
  store.transact('Rename', (tx) => {
    const id = (store.db.prepare('SELECT id FROM person LIMIT 1').get() as { id: string }).id;
    persons.update(tx, id, { sex: 'U' });
  });
  store.close();
  return dir;
}

describe('downgradeTree (test helper)', () => {
  it.each(Array.from({ length: LATEST_SCHEMA_VERSION - 1 }, (_, i) => i + 1))(
    'turns a current tree into a version %i tree with the same data',
    (version) => {
      const dir = populated();
      downgradeTree(dir, version);

      const db = new Database(join(dir, 'tree.sqlite'), { readonly: true });
      expect(dumpSchema(db)).toBe(
        readFileSync(join(historyDir, `schema-v${version}.sql`), 'utf8').trim(),
      );
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get()).toBe(
        String(version),
      );
      expect(db.prepare('SELECT count(*) FROM person').pluck().get()).toBe(9);
      expect(db.prepare('SELECT count(*) FROM change_batch').pluck().get()).toBe(2);
      db.close();

      // Opening it runs the real migrations from that version, and history still works.
      const store = openTree(dir);
      expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      expect(persons.list(store)).toHaveLength(9);
      expect(undoLast(store)?.label).toBe('Rename');
      store.close();
    },
  );

  it('refuses versions it has no frozen schema for', () => {
    const dir = populated();
    expect(() => downgradeTree(dir, 0)).toThrow(/version/);
    expect(() => downgradeTree(dir, LATEST_SCHEMA_VERSION + 1)).toThrow(/version/);
  });
});
