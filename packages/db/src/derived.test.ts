import { parseDate } from '@open-ancestry/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTree,
  events,
  exportJson,
  importJson,
  openMemoryTree,
  openTree,
  persons,
  redoLast,
  refreshDerivedColumns,
  searchPeople,
  undoLast,
  type TreeStore,
} from './index';

const HEBREW = '@#DHEBREW@ 1 TSH 5780';
const FRENCH = '@#DFRENCH R@ BET 1 VEND 3 AND 5 FLOR 7';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-derived-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const count = (store: TreeStore, table: string) =>
  (store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

const sorts = (store: TreeStore) =>
  store.db
    .prepare('SELECT date_text, date_sort, date_sort_end FROM event ORDER BY date_text')
    .all();

/**
 * A person with a Hebrew birth, a French Republican residence and a Gregorian
 * death, each stored with sort keys as an older date parser left them.
 */
function seedStale(store: TreeStore) {
  return store.transact('seed', (tx) => {
    const p = persons.create(tx, { names: [{ given: 'Isolde', surname: 'Marren' }] });
    for (const [type, date_text, calendar] of [
      ['BIRT', HEBREW, 'hebrew'],
      ['RESI', FRENCH, 'french_r'],
      ['DEAT', '1850', null],
    ] as const) {
      events.create(tx, {
        type,
        date_text,
        calendar,
        date_sort: 10000101,
        date_sort_end: null,
        roles: [{ person_id: p.id }],
      });
    }
    return p.id;
  }).result;
}

/** Makes the tree look like it was written by an older parser. */
function forgetFingerprints(store: TreeStore) {
  store.db.exec('DELETE FROM derived_state');
}

describe('derived column refresh', () => {
  it('recomputes non-Gregorian sort keys from date_text, without touching change_log', () => {
    const store = openMemoryTree();
    const id = seedStale(store);
    const logged = count(store, 'change_log');
    const result = refreshDerivedColumns(store, { force: true });
    expect(result).toEqual({ event_date_sort: 2 });
    const french = parseDate(FRENCH);
    expect(sorts(store)).toEqual([
      { date_text: FRENCH, date_sort: french.sortKey, date_sort_end: french.sortKeyEnd },
      { date_text: HEBREW, date_sort: parseDate(HEBREW).sortKey, date_sort_end: null },
      // Gregorian rows are left alone.
      { date_text: '1850', date_sort: 10000101, date_sort_end: null },
    ]);
    expect(count(store, 'change_log')).toBe(logged);
    // The search index follows: years come from date_sort.
    expect(searchPeople(store, 'marren 2019').map((r) => r.person.id)).toEqual([id]);
    // Idempotent.
    expect(refreshDerivedColumns(store, { force: true })).toEqual({ event_date_sort: 0 });
    store.close();
  });

  it('runs on open only when the date parser changed, and logs what it did', () => {
    const dir = join(root, 'stale.oatree');
    let store = createTree(dir);
    seedStale(store);
    store.close();

    const messages: string[] = [];
    store = openTree(dir, { log: (m) => messages.push(m) });
    // Fingerprints match the current parser: nothing recomputed.
    expect(messages).toEqual([]);
    expect(sorts(store)[1]).toMatchObject({ date_sort: 10000101 });
    forgetFingerprints(store);
    store.close();

    store = openTree(dir, { log: (m) => messages.push(m) });
    expect(messages).toEqual(['Recomputed event_date_sort for 2 rows (date parser changed)']);
    expect(sorts(store)[1]).toMatchObject({ date_sort: parseDate(HEBREW).sortKey });
    store.close();

    messages.length = 0;
    openTree(dir, { log: (m) => messages.push(m) }).close();
    expect(messages).toEqual([]);
  });

  it('keeps undo working across a recompute, restoring fresh sort keys', () => {
    const store = openMemoryTree();
    seedStale(store);
    store.transact('note it', (tx) => {
      const birth = store.db.prepare('SELECT id FROM event WHERE date_text = ?').get(HEBREW) as {
        id: string;
      };
      events.update(tx, birth.id, { description: 'at home' });
    });
    refreshDerivedColumns(store, { force: true });
    const fresh = sorts(store);
    // The logged images still carry the stale keys; undo must not see a conflict.
    expect(undoLast(store)?.label).toBe('note it');
    expect(redoLast(store)?.label).toBe('note it');
    expect(sorts(store)).toEqual(fresh);
    expect(undoLast(store)?.label).toBe('note it');
    expect(undoLast(store)?.label).toBe('seed');
    expect(count(store, 'event')).toBe(0);
    redoLast(store);
    expect(sorts(store)).toEqual(fresh);
    store.close();
  });

  it('recomputes rows loaded from a JSON backup', () => {
    const source = openMemoryTree();
    seedStale(source);
    const doc = exportJson(source);
    source.close();
    const store = openMemoryTree();
    importJson(store, doc);
    expect(sorts(store)[1]).toMatchObject({ date_sort: parseDate(HEBREW).sortKey });
    store.close();
  });
});
