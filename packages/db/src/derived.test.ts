import { parseDate } from '@open-ancestry/core';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  countPeople,
  createTree,
  events,
  exportJson,
  importJson,
  openMemoryTree,
  openTree,
  persons,
  redoLast,
  rebuildSearchIndex,
  rebuildSearchIndexInChunks,
  refreshDerivedColumns,
  searchIndexStale,
  searchPeople,
  undoLast,
  type TreeStore,
} from './index';
import { makeTempDir } from '../../../fixtures/temp-dir';

const HEBREW = '@#DHEBREW@ 1 TSH 5780';
const FRENCH = '@#DFRENCH R@ BET 1 VEND 3 AND 5 FLOR 7';

let root: string;
beforeEach(() => {
  root = makeTempDir('oa-derived-');
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
    expect(result).toMatchObject({ event_date_sort: 2 });
    const french = parseDate(FRENCH);
    expect(sorts(store)).toEqual([
      // Gregorian rows are left alone.
      { date_text: '1850', date_sort: 10000101, date_sort_end: null },
      { date_text: FRENCH, date_sort: french.sortKey, date_sort_end: french.sortKeyEnd },
      { date_text: HEBREW, date_sort: parseDate(HEBREW).sortKey, date_sort_end: null },
    ]);
    expect(count(store, 'change_log')).toBe(logged);
    // The search index follows: years come from date_sort.
    expect(searchPeople(store, 'marren 2019').map((r) => r.person.id)).toEqual([id]);
    // Idempotent.
    expect(refreshDerivedColumns(store, { force: true })).toMatchObject({ event_date_sort: 0 });
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
    expect(sorts(store)[2]).toMatchObject({ date_sort: 10000101 });
    forgetFingerprints(store);
    store.close();

    store = openTree(dir, { log: (m) => messages.push(m) });
    expect(messages).toContain('Recomputed event_date_sort for 2 rows (date parser changed)');
    expect(sorts(store)[2]).toMatchObject({ date_sort: parseDate(HEBREW).sortKey });
    store.close();

    messages.length = 0;
    openTree(dir, { log: (m) => messages.push(m) }).close();
    expect(messages).toEqual([]);
  });

  it('rebuilds the search index on open when the search fold changed (#199)', () => {
    const dir = join(root, 'search.oatree');
    let store = createTree(dir);
    const { result: p } = store.transact('add', (tx) =>
      persons.create(tx, { names: [{ given: 'Emre', surname: 'Yılmaz' }] }),
    );
    store.db.prepare("DELETE FROM derived_state WHERE name = 'search_index'").run();
    store.close();

    const messages: string[] = [];
    store = openTree(dir, { log: (m) => messages.push(m) });
    expect(messages).toEqual(['Recomputed search_index for 1 rows (search fold changed)']);
    expect(searchPeople(store, 'yilmaz').map((r) => r.person.id)).toEqual([p.id]);
    store.close();
    messages.length = 0;
    openTree(dir, { log: (m) => messages.push(m) }).close();
    expect(messages).toEqual([]);
  });

  it('can leave a stale search index for a chunked rebuild off the open path', () => {
    const dir = join(root, 'deferred.oatree');
    let store = createTree(dir);
    const ids = store.transact('add', (tx) =>
      ['Yılmaz', 'Straße', 'Kaya'].map(
        (surname) => persons.create(tx, { names: [{ given: 'Ada', surname }] }).id,
      ),
    ).result;
    store.db.prepare("DELETE FROM derived_state WHERE name = 'search_index'").run();
    store.close();

    const messages: string[] = [];
    store = openTree(dir, { log: (m) => messages.push(m), deferSearch: true });
    expect(messages).toEqual([]);
    expect(searchIndexStale(store)).toBe(true);
    // Each step refreshes one chunk; search keeps working between them.
    const steps = [...rebuildSearchIndexInChunks(store, 2)];
    expect(steps).toEqual([2, 3]);
    expect(searchIndexStale(store)).toBe(false);
    expect(searchPeople(store, 'yilmaz').map((r) => r.person.id)).toEqual([ids[0]]);
    expect(searchPeople(store, 'strasse').map((r) => r.person.id)).toEqual([ids[1]]);
    expect(messages).toEqual(['Recomputed search_index for 3 rows (search fold changed)']);
    store.close();
  });

  it('finds people by their old spelling while a deferred rebuild is pending', () => {
    const dir = join(root, 'pending.oatree');
    let store = createTree(dir);
    const id = store.transact('add', (tx) =>
      persons.create(tx, { names: [{ given: 'Emre', surname: 'Yılmaz' }] }),
    ).result.id;
    // An index written before the fold: the name as typed, and no fingerprint.
    store.db
      .prepare(
        "UPDATE person_search SET names = 'Emre Yılmaz' WHERE rowid = (SELECT doc_id FROM search_doc WHERE person_id = ?)",
      )
      .run(id);
    store.db.prepare("DELETE FROM derived_state WHERE name = 'search_index'").run();
    store.close();

    store = openTree(dir, { deferSearch: true, log: () => {} });
    expect(store.searchRebuildPending).toBe(true);
    // The query is folded to "yilmaz", which the old document lacks; the spelling
    // as typed still finds it, as it did before the upgrade.
    expect(searchPeople(store, 'Yılmaz').map((r) => r.person.id)).toEqual([id]);
    // The palette's total counts the same way (#305's countPeople).
    expect(countPeople(store, 'Yılmaz')).toBe(1);
    for (const done of rebuildSearchIndexInChunks(store)) void done;
    expect(store.searchRebuildPending).toBe(false);
    expect(searchPeople(store, 'Yılmaz').map((r) => r.person.id)).toEqual([id]);
    expect(searchPeople(store, 'Yilmaz').map((r) => r.person.id)).toEqual([id]);
    expect(countPeople(store, 'Yilmaz')).toBe(1);
    // A full rebuild clears the flag too, so it always agrees with the index.
    store.searchRebuildPending = true;
    rebuildSearchIndex(store);
    expect(store.searchRebuildPending).toBe(false);
    store.close();
  });

  it('keeps an edit made between rebuild chunks', () => {
    const dir = join(root, 'edit-between.oatree');
    let store = createTree(dir);
    const ids = store
      .transact('add', (tx) =>
        ['Aksoy', 'Yılmaz', 'Kaya'].map(
          (surname) => persons.create(tx, { names: [{ given: 'Ada', surname }] }).id,
        ),
      )
      .result.sort();
    store.db.prepare("DELETE FROM derived_state WHERE name = 'search_index'").run();
    store.close();

    store = openTree(dir, { deferSearch: true, log: () => {} });
    const chunks = rebuildSearchIndexInChunks(store, 1);
    expect(chunks.next().value).toBe(1);
    // Rename someone whose chunk has not run yet, and someone whose chunk has.
    store.transact('rename', (tx) => {
      for (const [id, surname] of [
        [ids[2]!, 'Öztürk'],
        [ids[0]!, 'Şahin'],
      ] as const) {
        const name = tx.store.stmt('SELECT id FROM person_name WHERE person_id = ?').get(id) as {
          id: string;
        };
        tx.update('person_name', name.id, { surname });
      }
    });
    for (const done of chunks) void done;
    expect(searchIndexStale(store)).toBe(false);
    expect(searchPeople(store, 'ozturk').map((r) => r.person.id)).toEqual([ids[2]]);
    expect(searchPeople(store, 'sahin').map((r) => r.person.id)).toEqual([ids[0]]);
    store.close();
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
    expect(sorts(store)[2]).toMatchObject({ date_sort: parseDate(HEBREW).sortKey });
    store.close();
  });
});
