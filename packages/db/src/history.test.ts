import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  createTree,
  createUlidFactory,
  events,
  exportJson,
  exportJsonString,
  importJson,
  listBatches,
  openMemoryTree,
  openTree,
  parseLogImage,
  persons,
  places,
  redoLast,
  undoLast,
  type Migration,
  type OaJsonDocument,
  type TreeStore,
  type Tx,
} from './index';
import { fixedClock } from './test/helpers';

const historyDir = join(import.meta.dirname, 'migrations', 'history');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-history-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const count = (store: TreeStore, table: string) =>
  (store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** User data only, canonical: what undo and redo must restore exactly. */
const snapshot = (store: TreeStore) => exportJsonString(store, { history: false });

/** Undoes everything, newest first, then redoes it all; returns the labels in each order. */
function undoRedoAll(store: TreeStore) {
  const undone: string[] = [];
  for (let b = undoLast(store); b; b = undoLast(store)) undone.push(b.label);
  const redone: string[] = [];
  for (let b = redoLast(store); b; b = redoLast(store)) redone.push(b.label);
  return { undone, redone };
}

describe('undo order follows commit order, not the clock (#100)', () => {
  it('undoes the newest edit after a later session starts with its clock behind', () => {
    const T = Date.parse('2026-10-14T12:00:00Z');
    const dir = join(root, 'skew.oatree');
    let store = createTree(dir, { newId: createUlidFactory({ now: () => T }) });
    const p = store.transact('create', (tx) => persons.create(tx, { sex: 'U' })).result;
    store.transact('A: set F', (tx) => persons.update(tx, p.id, { sex: 'F' }));
    store.close();
    store = openTree(dir, { newId: createUlidFactory({ now: () => T - 3_600_000 }) });
    store.transact('B: set M', (tx) => persons.update(tx, p.id, { sex: 'M' }));

    expect(listBatches(store).map((b) => b.label)).toEqual(['B: set M', 'A: set F', 'create']);
    expect(undoLast(store)?.label).toBe('B: set M');
    expect(persons.get(store, p.id)?.sex).toBe('F');
    expect(undoLast(store)?.label).toBe('A: set F');
    expect(redoLast(store)?.label).toBe('A: set F');
    expect(redoLast(store)?.label).toBe('B: set M');
    store.close();
  });

  it('numbers batches 1, 2, 3 in commit order', () => {
    const store = openMemoryTree();
    for (const label of ['one', 'two', 'three'])
      store.transact(label, (tx) => persons.create(tx, {}));
    expect(store.db.prepare('SELECT label, seq FROM change_batch ORDER BY seq').all()).toEqual([
      { label: 'one', seq: 1 },
      { label: 'two', seq: 2 },
      { label: 'three', seq: 3 },
    ]);
    // A batch that changes nothing is dropped and does not burn a number.
    store.transact('noop', () => null);
    store.transact('four', (tx) => persons.create(tx, {}));
    expect(listBatches(store)[0]).toMatchObject({ label: 'four', seq: 4 });
    store.close();
  });
});

/** Frozen per-version fixtures: history/oa-vN.json, written by freeze-history-fixture. */
function frozenFixtures(): number[] {
  return readdirSync(historyDir)
    .map((f) => /^oa-v(\d+)\.json$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

function readFixture(version: number): OaJsonDocument {
  return JSON.parse(
    readFileSync(join(historyDir, `oa-v${version}.json`), 'utf8'),
  ) as OaJsonDocument;
}

/** A tree folder exactly as version N of the app left it: frozen schema plus frozen rows. */
function frozenTree(version: number): string {
  const dir = join(root, `frozen-v${version}.oatree`);
  mkdirSync(dir);
  const db = new Database(join(dir, 'tree.sqlite'));
  db.exec(readFileSync(join(historyDir, `schema-v${version}.sql`), 'utf8'));
  for (const [table, rows] of Object.entries(readFixture(version).tables)) {
    for (const row of rows as Record<string, unknown>[]) {
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ).run(columns.map((c) => row[c]));
    }
  }
  db.close();
  return dir;
}

// The fixture's batches in commit order; the last two were made by a session
// whose clock was an hour behind, and "Add note" was undone.
const FIXTURE_HISTORY = [
  'Add note',
  'Delete sister',
  'Set sex',
  'Add married name',
  'Rename town',
  'Seed family',
];

describe('history from every released version stays usable (#101)', () => {
  it('has a frozen history fixture for every released schema version', () => {
    expect(frozenFixtures()).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it.each(frozenFixtures())('a v%i tree upgrades and undoes and redoes its whole history', (v) => {
    const store = openTree(frozenTree(v));
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(listBatches(store).map((b) => b.label)).toEqual(FIXTURE_HISTORY);
    const before = snapshot(store);
    const { undone, redone } = undoRedoAll(store);
    expect(undone).toEqual(FIXTURE_HISTORY.slice(1));
    expect(redone).toEqual([...FIXTURE_HISTORY].reverse());
    // Redo includes the batch that was already undone in the fixture.
    expect(count(store, 'note')).toBe(1);
    undoLast(store);
    expect(snapshot(store)).toBe(before);
    store.close();
  });

  it.each(frozenFixtures())('a v%i JSON backup imports and undoes its whole history', (v) => {
    const store = openMemoryTree();
    importJson(store, readFixture(v));
    expect(listBatches(store).map((b) => b.label)).toEqual(FIXTURE_HISTORY);
    const fromDatabase = openTree(frozenTree(v));
    expect(snapshot(store)).toBe(snapshot(fromDatabase));
    fromDatabase.close();
    const { undone } = undoRedoAll(store);
    expect(undone).toEqual(FIXTURE_HISTORY.slice(1));
    store.close();
  });

  it('refuses JSON from a newer schema version', () => {
    const store = openMemoryTree();
    const doc = readFixture(1);
    expect(() => importJson(store, { ...doc, schemaVersion: LATEST_SCHEMA_VERSION + 1 })).toThrow(
      /newer/,
    );
    store.close();
  });
});

// A stand-in for the next real migration: adds, renames and drops columns.
const SIMULATED: Migration = {
  version: LATEST_SCHEMA_VERSION + 1,
  name: 'simulated',
  sql: `
    ALTER TABLE person ADD COLUMN future_col TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE place RENAME COLUMN type TO kind;
    ALTER TABLE event DROP COLUMN cause;
  `,
  columns: {
    person: { added: { future_col: 'none' } },
    place: { renamed: { type: 'kind' } },
    event: { dropped: ['cause'] },
  },
};
const UPGRADED = [...MIGRATIONS, SIMULATED];

const STEPS: [string, (tx: Tx, ids: Record<string, string>) => void][] = [
  [
    'Seed',
    (tx, ids) => {
      ids.town = places.create(tx, { name: 'Wexmoor', full_name: 'Wexmoor', type: 'town' }).id;
      ids.person = persons.create(tx, {
        sex: 'F',
        names: [{ given: 'Hazel', surname: 'Moor' }],
      }).id;
      ids.death = events.create(tx, {
        type: 'DEAT',
        cause: 'Fever',
        place_id: ids.town,
        roles: [{ person_id: ids.person }],
      }).id;
    },
  ],
  [
    'Rename town',
    (tx, ids) => places.update(tx, ids.town as string, { full_name: 'Wexmoor Parva' }),
  ],
  [
    'Edit death',
    (tx, ids) => events.update(tx, ids.death as string, { cause: 'Influenza', date_text: '1901' }),
  ],
  ['Set sex', (tx, ids) => persons.update(tx, ids.person as string, { sex: 'U' })],
  ['Delete', (tx, ids) => persons.delete(tx, ids.person as string)],
];

/** A tree at the current version with the first `steps` batches, deterministic ids and times. */
function build(name: string, steps: number): string {
  const dir = join(root, name, 'tree.oatree');
  mkdirSync(join(root, name));
  let seed = 3;
  const store = createTree(dir, {
    clock: fixedClock(),
    newId: createUlidFactory({
      now: () => 1_700_000_000_000,
      random: () => (seed = (seed * 31 + 7) % 997) % 32,
    }),
  });
  const ids: Record<string, string> = {};
  for (const [label, step] of STEPS.slice(0, steps)) store.transact(label, (tx) => step(tx, ids));
  store.close();
  return dir;
}

describe('a future migration keeps older history working (simulated)', () => {
  it('undoes and redoes batches recorded before the upgrade, exactly', () => {
    const expected = STEPS.map((_, i) => {
      const store = openTree(build(`expected-${i}`, i), { migrations: UPGRADED });
      const state = snapshot(store);
      store.close();
      return state;
    });
    const store = openTree(build('actual', STEPS.length), { migrations: UPGRADED });
    expect(store.schemaVersion).toBe(SIMULATED.version);
    expect(store.db.prepare('SELECT kind FROM place').get()).toEqual({ kind: 'town' });
    const full = snapshot(store);
    for (let i = STEPS.length - 1; i >= 0; i--) {
      expect(undoLast(store)?.label).toBe(STEPS[i]?.[0]);
      expect(snapshot(store)).toBe(expected[i]);
    }
    for (let b = redoLast(store); b; b = redoLast(store));
    expect(snapshot(store)).toBe(full);
    // New edits after the upgrade are stamped with the new version.
    store.transact('after upgrade', (tx) => persons.create(tx, {}));
    expect(
      store.db.prepare('SELECT DISTINCT schema_version AS v FROM change_log ORDER BY v').all(),
    ).toEqual([{ v: LATEST_SCHEMA_VERSION }, { v: SIMULATED.version }]);
    store.close();
  });

  it('imports a backup from before the upgrade and can undo its history', () => {
    const before = openTree(build('backup', STEPS.length));
    const doc = exportJson(before);
    before.close();
    const migrated = openTree(build('migrated', STEPS.length), { migrations: UPGRADED });
    const store = openMemoryTree({ migrations: UPGRADED });
    importJson(store, doc);
    expect(exportJson(store).schemaVersion).toBe(SIMULATED.version);
    expect(snapshot(store)).toBe(snapshot(migrated));
    migrated.close();
    expect(undoRedoAll(store).undone).toEqual(STEPS.map(([label]) => label).reverse());
    store.close();
  });
});

describe('change_log images are tolerant and versioned', () => {
  function personImage(store: TreeStore) {
    const { result: p } = store.transact('add', (tx) => persons.create(tx, { sex: 'F' }));
    return p as unknown as Record<string, unknown>;
  }

  it('ignores extra columns and fills missing ones with their defaults', () => {
    const store = openMemoryTree();
    const row = personImage(store);
    const id = row.id as string;
    const withExtra = JSON.stringify({ ...row, 'dropped_col; DROP TABLE person': 1 });
    expect(parseLogImage(store, 'person', id, withExtra)).toEqual(row);
    const { privacy: _privacy, primary_media_id: _media, ...missing } = row;
    expect(parseLogImage(store, 'person', id, JSON.stringify(missing))).toEqual({
      ...row,
      privacy: 'public',
      primary_media_id: null,
    });
    store.close();
  });

  it('refuses images missing a required column, or from a newer version', () => {
    const store = openMemoryTree();
    const row = personImage(store);
    const { created_at: _created, ...missing } = row;
    expect(() => parseLogImage(store, 'person', row.id as string, JSON.stringify(missing))).toThrow(
      /missing created_at/,
    );
    expect(() =>
      parseLogImage(
        store,
        'person',
        row.id as string,
        JSON.stringify(row),
        LATEST_SCHEMA_VERSION + 1,
      ),
    ).toThrow(/newer/);
    store.close();
  });

  it('stamps every change_log row with the schema version it was written under', () => {
    const store = openMemoryTree();
    personImage(store);
    expect(store.db.prepare('SELECT DISTINCT schema_version AS v FROM change_log').all()).toEqual([
      { v: LATEST_SCHEMA_VERSION },
    ]);
    store.close();
  });
});
