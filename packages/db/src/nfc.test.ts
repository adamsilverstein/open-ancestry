import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BulkWriter,
  LATEST_SCHEMA_VERSION,
  createTree,
  exportJson,
  importJson,
  listBatches,
  openMemoryTree,
  openTree,
  persons,
  places,
  searchPeople,
  toNFC,
  redo,
  undo,
  undoLast,
  undoLatest,
  UndoConflictError,
  type TreeStore,
} from './index';

const NFD = (s: string) => s.normalize('NFD');
const NFC = (s: string) => s.normalize('NFC');
const isNFD = (s: string) => s === NFD(s) && s !== NFC(s);

describe('toNFC', () => {
  it('composes decomposed text and leaves ASCII and NFC text unchanged', () => {
    expect(toNFC(NFD('Zürich'))).toBe(NFC('Zürich'));
    expect(toNFC('Zurich')).toBe('Zurich');
    const nfc = NFC('Zoë');
    expect(toNFC(nfc)).toBe(nfc);
  });
});

describe('Tx writes', () => {
  it('stores NFD names, places and notes as NFC', () => {
    const store = openMemoryTree();
    const { result } = store.transact('add', (tx) => {
      const person = persons.create(tx, {
        names: [{ given: NFD('José'), surname: NFD('Müller') }],
      });
      const place = places.create(tx, { name: NFD('Zürich'), full_name: NFD('Zürich, Schweiz') });
      const note = tx.insert('note', { text: NFD('Über alles') });
      return { person, place, note };
    });
    const name = store.db
      .prepare('SELECT given, surname FROM person_name WHERE person_id = ?')
      .get(result.person.id) as { given: string; surname: string };
    expect(name).toEqual({ given: NFC('José'), surname: NFC('Müller') });
    expect(store.getRow('place', result.place.id)).toMatchObject({
      name: NFC('Zürich'),
      full_name: NFC('Zürich, Schweiz'),
    });
    expect(store.getRow('note', result.note.id)?.text).toBe(NFC('Über alles'));
    store.close();
  });

  it('normalizes updates', () => {
    const store = openMemoryTree();
    const { result: place } = store.transact('add', (tx) =>
      places.create(tx, { name: 'Zurich', full_name: 'Zurich' }),
    );
    store.transact('edit', (tx) => tx.update('place', place.id, { full_name: NFD('Zürich') }));
    expect(store.getRow('place', place.id)?.full_name).toBe(NFC('Zürich'));
    store.close();
  });

  it('keeps verbatim columns: raw GEDCOM text, unmapped lines and media file paths', () => {
    const store = openMemoryTree();
    const raw = NFD('0 @I1@ INDI\n1 NAME José');
    store.transact('add', (tx) => {
      const batch = tx.insert('import_batch', { file_name: NFD('Zoë.ged') });
      tx.insert('raw_record', {
        import_batch_id: batch.id,
        seq: 0,
        gedcom_tag: 'INDI',
        raw_text: raw,
      });
      tx.insert('unmapped_line', {
        import_batch_id: batch.id,
        path: 'INDI._X',
        line_no: 2,
        line: NFD('1 _X Zoë'),
      });
      tx.insert('media', { kind: 'photo', local_path: NFD('photos/Zoë.jpg'), title: NFD('Zoë') });
    });
    const get = (sql: string) => store.db.prepare(sql).pluck().get() as string;
    expect(get('SELECT raw_text FROM raw_record')).toBe(raw);
    expect(isNFD(get('SELECT line FROM unmapped_line'))).toBe(true);
    expect(isNFD(get('SELECT file_name FROM import_batch'))).toBe(true);
    // The file on disk is named by local_path; changing it would lose the file on Linux.
    expect(isNFD(get('SELECT local_path FROM media'))).toBe(true);
    expect(get('SELECT title FROM media')).toBe(NFC('Zoë'));
    store.close();
  });
});

describe('schema v3: NFC normalization of existing trees', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A v1-era tree whose text was stored NFD (bulk import bypasses Tx normalization). */
  function legacyTree(more?: (store: TreeStore, ids: Record<string, string>) => void): {
    path: string;
    ids: Record<string, string>;
  } {
    dir = mkdtempSync(join(tmpdir(), 'oa-nfc-'));
    const path = join(dir, 'legacy.oatree');
    const store = createTree(path);
    const w = new BulkWriter(store);
    const batch = w.insert('import_batch', { file_name: 'legacy.ged' });
    const ids = {
      person: w.insert('person', {}),
      other: w.insert('person', {}),
      schweiz: w.insert('place', { name: 'Schweiz', full_name: 'Schweiz' }),
    } as Record<string, string>;
    ids.nfcPlace = w.insert('place', {
      name: NFC('Zürich'),
      full_name: NFC('Zürich, Schweiz'),
      parent_id: ids.schweiz!,
    });
    ids.nfdPlace = w.insert('place', {
      name: NFD('Zürich'),
      full_name: NFD('Zürich, Schweiz'),
      parent_id: ids.schweiz!,
      latitude: 47.37,
      longitude: 8.54,
    });
    ids.nfdChild = w.insert('place', {
      name: 'Altstadt',
      full_name: NFD('Altstadt, Zürich, Schweiz'),
      parent_id: ids.nfdPlace!,
    });
    ids.name = w.insert('person_name', {
      person_id: ids.person!,
      given: NFD('José'),
      surname: NFD('Müller'),
      is_primary: 1,
    });
    w.insert('person_name', { person_id: ids.other!, given: 'Ann', surname: 'Ash', is_primary: 1 });
    for (const [person, place] of [
      [ids.person!, ids.nfdPlace!],
      [ids.other!, ids.nfcPlace!],
    ] as const) {
      const event = w.insert('event', { type: 'BIRT', place_id: place });
      w.insert('event_role', { event_id: event, person_id: person, role: 'principal' });
      if (place === ids.nfdPlace) ids.nfdEvent = event;
    }
    const note = w.insert('note', { text: NFD('Notizen über Zürich') });
    w.insert('note_link', { note_id: note, owner_type: 'place', owner_id: ids.nfdPlace! });
    w.insert('note_link', { note_id: note, owner_type: 'place', owner_id: ids.nfcPlace! });
    ids.media = w.insert('media', {
      kind: 'photo',
      local_path: NFD('photos/Zoë.jpg'),
      title: NFD('Zoë'),
    });
    ids.nfcTag = w.insert('tag', { name: NFC('Geprüft'), category: 'Status' });
    ids.nfdTag = w.insert('tag', { name: NFD('Geprüft'), category: 'Status' });
    w.insert('tag_link', { tag_id: ids.nfcTag!, owner_type: 'person', owner_id: ids.person! });
    w.insert('tag_link', { tag_id: ids.nfdTag!, owner_type: 'person', owner_id: ids.person! });
    w.insert('tag_link', { tag_id: ids.nfdTag!, owner_type: 'person', owner_id: ids.other! });
    w.insert('raw_record', {
      import_batch_id: batch,
      seq: 0,
      gedcom_tag: 'INDI',
      raw_text: NFD('0 @I1@ INDI\n1 NAME José /Müller/'),
    });
    w.commit();
    store.db
      .prepare("UPDATE meta SET value = ? WHERE key = 'tree_name'")
      .run(NFD('Familie Müller'));
    // Edits made before the upgrade: their change_log images hold NFD text.
    ids.edit = store.transact('Add nickname', (tx) =>
      tx.update('person_name', ids.name!, { nickname: 'Pepe' }),
    ).batchId;
    ids.eventEdit = store.transact('Date the birth', (tx) =>
      tx.update('event', ids.nfdEvent!, { date_text: '1900' }),
    ).batchId;
    ids.placeEdit = store.transact('Set type', (tx) =>
      tx.update('place', ids.nfdChild!, { type: 'District' }),
    ).batchId;
    more?.(store, ids);
    // Pretend this tree and its history were written by version 2.
    store.db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    store.db.prepare('UPDATE change_log SET schema_version = 2').run();
    store.close();
    return { path, ids };
  }

  const all = (store: TreeStore, sql: string, ...params: unknown[]) =>
    store.db.prepare(sql).all(...params) as Record<string, unknown>[];
  const one = (store: TreeStore, sql: string, ...params: unknown[]) =>
    store.db
      .prepare(sql)
      .pluck()
      .get(...params);

  it('normalizes text, merges places and tags that collide, and keeps verbatim columns', () => {
    const { path, ids } = legacyTree();
    const store = openTree(path);
    expect(one(store, "SELECT value FROM meta WHERE key = 'schema_version'")).toBe(
      String(LATEST_SCHEMA_VERSION),
    );
    expect(all(store, 'SELECT given, surname FROM person_name ORDER BY given')).toEqual([
      { given: 'Ann', surname: 'Ash' },
      { given: NFC('José'), surname: NFC('Müller') },
    ]);
    expect(one(store, "SELECT value FROM meta WHERE key = 'tree_name'")).toBe(
      NFC('Familie Müller'),
    );
    expect(one(store, 'SELECT text FROM note')).toBe(NFC('Notizen über Zürich'));
    expect(store.getRow('media', ids.media!)).toMatchObject({
      title: NFC('Zoë'),
      local_path: NFD('photos/Zoë.jpg'),
    });
    expect(isNFD(one(store, 'SELECT raw_text FROM raw_record') as string)).toBe(true);

    // The two Zürich rows become one: the older id survives and keeps the coordinates.
    const zurich = all(store, 'SELECT * FROM place WHERE name = ?', NFC('Zürich'));
    expect(zurich).toHaveLength(1);
    expect(zurich[0]).toMatchObject({ id: ids.nfcPlace, latitude: 47.37, longitude: 8.54 });
    expect(store.getRow('place', ids.nfdPlace!)).toBeUndefined();
    expect(all(store, 'SELECT DISTINCT place_id FROM event')).toEqual([{ place_id: ids.nfcPlace }]);
    expect(store.getRow('place', ids.nfdChild!)).toMatchObject({
      full_name: NFC('Altstadt, Zürich, Schweiz'),
      parent_id: ids.nfcPlace,
    });
    expect(all(store, "SELECT owner_id FROM note_link WHERE owner_type = 'place'")).toEqual([
      { owner_id: ids.nfcPlace },
    ]);

    // The two Geprüft tags become one, without duplicate links.
    expect(all(store, 'SELECT id FROM tag')).toEqual([{ id: ids.nfcTag }]);
    expect(
      all(store, 'SELECT tag_id, owner_id FROM tag_link ORDER BY owner_id').map((r) => r.owner_id),
    ).toEqual([ids.person, ids.other].sort());

    // Search sees the normalized text.
    expect(searchPeople(store, NFD('müller')).map((r) => r.person.id)).toEqual([ids.person]);
    store.close();
  });

  it('is an upgrade, not an edit: History is unchanged', () => {
    const { path, ids } = legacyTree();
    const store = openTree(path);
    expect(listBatches(store).map((b) => b.id)).toEqual([ids.placeEdit, ids.eventEdit, ids.edit]);
    expect(one(store, 'SELECT count(*) FROM change_log WHERE schema_version = 3')).toBe(0);
    store.close();
  });

  it('still undoes and redoes a text edit made before the upgrade', () => {
    const { path, ids } = legacyTree();
    const store = openTree(path);
    // Its images hold NFD text; upgradeRow normalizes them, so they match the live row.
    undo(store, ids.edit!);
    expect(store.getRow('person_name', ids.name!)).toMatchObject({
      nickname: null,
      given: NFC('José'),
    });
    redo(store, ids.edit!);
    expect(store.getRow('person_name', ids.name!)?.nickname).toBe('Pepe');
    store.close();
  });

  it.each([
    ['a child of a merged place', 'placeEdit', 'place', 'nfdChild'],
    ['an event at a merged place', 'eventEdit', 'event', 'nfdEvent'],
  ] as const)(
    'refuses to undo an earlier edit to %s, with the tree unchanged',
    (_, batch, table, row) => {
      const { path, ids } = legacyTree();
      const store = openTree(path);
      const before = JSON.stringify(store.getRow(table, ids[row]!));
      const history = JSON.stringify(listBatches(store));
      // Its images name the place merged away, which no longer exists.
      expect(() => undo(store, ids[batch]!)).toThrow(UndoConflictError);
      expect(() => undo(store, ids[batch]!)).toThrow(
        /merged during an upgrade, so it can't be undone\. Older changes stay in History\./,
      );
      expect(JSON.stringify(store.getRow(table, ids[row]!))).toBe(before);
      expect(store.getRow(table, ids[row]!)).toMatchObject(
        table === 'event' ? { place_id: ids.nfcPlace } : { parent_id: ids.nfcPlace },
      );
      expect(JSON.stringify(listBatches(store))).toBe(history);
      store.close();
    },
  );

  it('lets Cmd-Z step over edits that can no longer be undone', () => {
    const { path, ids } = legacyTree();
    const store = openTree(path);
    // The two newest batches name the merged place; the nickname edit behind them undoes.
    expect(undoLast(store)?.id).toBe(ids.edit);
    expect(store.getRow('person_name', ids.name!)?.nickname).toBeNull();
    expect(undoLast(store)).toBeNull();
    store.close();
  });

  it('Cmd-Z refuses to step over into an edit a skipped one still links to (no orphans)', () => {
    // review-22's case: B1 adds Pat; B2 notes the merged place and Pat. B2 can no longer be
    // undone, and undoing B1 would delete Pat while B2's note_link still points at Pat.
    const { path, ids } = legacyTree((store, ids) => {
      ids.addPat = store.transact('Add Pat', (tx) => {
        ids.pat = persons.create(tx, { names: [{ given: 'Pat', surname: 'Ash' }] }).id;
      }).batchId;
      ids.addNote = store.transact('Add note', (tx) => {
        const note = tx.insert('note', { text: 'Seen in Zurich' });
        tx.insert('note_link', { note_id: note.id, owner_type: 'place', owner_id: ids.nfdPlace! });
        tx.insert('note_link', { note_id: note.id, owner_type: 'person', owner_id: ids.pat! });
      }).batchId;
    });
    const store = openTree(path);
    expect(() => undoLatest(store)).toThrow(/still links to the person it would remove/);
    expect(store.getRow('person', ids.pat!)).toBeDefined();
    expect(listBatches(store).find((b) => b.id === ids.addPat)?.state).toBe('applied');
    store.close();
  });

  it('reports the batches Cmd-Z stepped over', () => {
    const { path, ids } = legacyTree();
    const store = openTree(path);
    const { batch, skipped } = undoLatest(store);
    expect(batch?.id).toBe(ids.edit);
    expect(skipped.map((b) => b.id)).toEqual([ids.placeEdit, ids.eventEdit]);
    store.close();
  });

  it('normalizes and merges an older JSON backup on import, without a change batch', () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-nfc-'));
    const source = openMemoryTree();
    const w = new BulkWriter(source);
    w.insert('person', { id: 'P1' } as never);
    w.insert('person_name', { person_id: 'P1', given: NFD('José'), surname: NFD('Müller') });
    w.insert('place', { id: 'A', name: NFC('Zürich'), full_name: NFC('Zürich') } as never);
    w.insert('place', { id: 'B', name: NFD('Zürich'), full_name: NFD('Zürich') } as never);
    const event = w.insert('event', { type: 'BIRT', place_id: 'B' });
    w.insert('event_role', { event_id: event, person_id: 'P1', role: 'principal' });
    w.insert('tag', { id: 'T1', name: NFC('Geprüft') } as never);
    w.insert('tag', { id: 'T2', name: NFD('Geprüft') } as never);
    w.insert('tag_link', { tag_id: 'T1', owner_type: 'person', owner_id: 'P1' });
    w.insert('tag_link', { tag_id: 'T2', owner_type: 'person', owner_id: 'P1' });
    w.commit();
    const doc = { ...exportJson(source), schemaVersion: 2 };
    const target = openMemoryTree();
    importJson(target, doc);
    expect(one(target, 'SELECT given FROM person_name')).toBe(NFC('José'));
    expect(all(target, 'SELECT id FROM place')).toEqual([{ id: 'A' }]);
    expect(one(target, 'SELECT place_id FROM event')).toBe('A');
    expect(all(target, 'SELECT tag_id FROM tag_link')).toEqual([{ tag_id: 'T1' }]);
    expect(listBatches(target)).toEqual([]);
    source.close();
    target.close();
  });

  it('does nothing visible on a fresh tree', () => {
    const store = openMemoryTree();
    expect(listBatches(store)).toEqual([]);
    store.close();
  });
});
