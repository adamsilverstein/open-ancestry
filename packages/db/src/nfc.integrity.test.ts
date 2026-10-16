import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  TreeStore,
  exportJson,
  importJson,
  migrate,
  openMemoryTree,
  persons,
  places,
  searchPeople,
} from './index';

const NFD = (s: string) => s.normalize('NFD');
const NFC = (s: string) => s.normalize('NFC');

describe('NFC on JSON import of a current-version document', () => {
  it('stores names from a current-version backup as NFC', () => {
    const source = openMemoryTree();
    source.transact('add', (tx) =>
      persons.create(tx, { names: [{ given: 'Zoe', surname: 'Quillfeather' }] }),
    );
    const doc = exportJson(source);
    source.close();
    // A backup written by another tool (or hand-edited on macOS) with decomposed text.
    for (const name of doc.tables.person_name) {
      name.given = NFD('Zoë');
      name.surname = NFD('Müllerbrook');
    }
    const target = openMemoryTree();
    importJson(target, doc);
    const row = target.db.prepare('SELECT given, surname FROM person_name').get() as {
      given: string;
      surname: string;
    };
    expect(row).toEqual({ given: NFC('Zoë'), surname: NFC('Müllerbrook') });
    target.close();
  });
});

describe('v3 NFC upgrade and places that were already identical', () => {
  it('keeps two ASCII places with the same name but different coordinates apart', () => {
    const db = new Database(':memory:');
    migrate(db, { to: 2 });
    const now = '2020-01-01T00:00:00.000Z';
    const insert = db.prepare(
      'INSERT INTO place (id, name, full_name, latitude, longitude, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    // Two distinct towns the user kept apart (e.g. after a rename), nothing to normalize.
    insert.run('P1', 'Brindlewick', 'Brindlewick', 10, 10, now, now);
    insert.run('P2', 'Brindlewick', 'Brindlewick', 40, 40, now, now);
    const store = new TreeStore(db, null);
    const rows = store.db.prepare('SELECT id, latitude FROM place ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'P1', latitude: 10 },
      { id: 'P2', latitude: 40 },
    ]);
    store.close();
  });

  it('the app itself can create two places with the same full name', () => {
    const store = openMemoryTree();
    store.transact('two', (tx) => {
      places.create(tx, { name: 'Brindlewick', full_name: 'Brindlewick', latitude: 10 });
      places.create(tx, { name: 'Brindlewick', full_name: 'Brindlewick', latitude: 40 });
    });
    expect(store.db.prepare('SELECT count(*) FROM place').pluck().get()).toBe(2);
    store.close();
  });
});

describe('URLs stay byte-exact', () => {
  it('keeps citation and repository URLs verbatim, like media.remote_url', () => {
    const store = openMemoryTree();
    // A link to a file served from a macOS volume: its path is decomposed on the server.
    const url = NFD('https://archive.example.org/scans/Zoë Quill.pdf');
    const { result } = store.transact('add', (tx) => {
      const repository = tx.insert('repository', { name: 'County Archive', url });
      const source = tx.insert('source', { title: 'Parish book', repository_id: repository.id });
      const citation = tx.insert('citation', { source_id: source.id, url });
      return { repository, citation };
    });
    expect(store.getRow('repository', result.repository.id)?.url).toBe(url);
    expect(store.getRow('citation', result.citation.id)?.url).toBe(url);
    store.close();
  });
});
