import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  TreeStore,
  exportJson,
  importJson,
  meta,
  migrate,
  names,
  openMemoryTree,
  persons,
  places,
  tagLinks,
  tags,
  undoLast,
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

describe('NFC on JSON import keeps history undoable', () => {
  it('undoes an edit from a current-version backup written entirely as NFD', () => {
    const source = openMemoryTree();
    const { result: person } = source.transact('add', (tx) =>
      persons.create(tx, { names: [{ given: 'Zoë', surname: 'Müllerbrook' }] }),
    );
    const name = names.list(source, person.id)[0]!;
    source.transact('Rename', (tx) => names.update(tx, name.id, { given: 'Zoë Ann' }));
    // Another tool rewrote the whole backup decomposed, change history included.
    const doc = JSON.parse(NFD(JSON.stringify(exportJson(source)))) as ReturnType<
      typeof exportJson
    >;
    source.close();
    const target = openMemoryTree();
    importJson(target, doc);
    expect(undoLast(target)?.label).toBe('Rename');
    expect(target.getRow('person_name', name.id)?.given).toBe(NFC('Zoë'));
    target.close();
  });
});

describe('NFC on JSON import merges tags that differ only in normalization', () => {
  it('folds an NFD copy of a tag into the NFC one, as the v3 upgrade does', () => {
    const source = openMemoryTree();
    const { result } = source.transact('add', (tx) => {
      const person = persons.create(tx, { names: [{ given: 'Ada', surname: 'Quill' }] });
      const other = persons.create(tx, { names: [{ given: 'Ben', surname: 'Quill' }] });
      const first = tags.create(tx, { category: 'Research', name: 'Zoë research' });
      const second = tags.create(tx, { category: 'Research', name: 'Zoe research' });
      tagLinks.create(tx, { tag_id: first.id, owner_type: 'person', owner_id: person.id });
      tagLinks.create(tx, { tag_id: second.id, owner_type: 'person', owner_id: person.id });
      tagLinks.create(tx, { tag_id: second.id, owner_type: 'person', owner_id: other.id });
      return { person, other, first, second };
    });
    const doc = exportJson(source);
    source.close();
    // The second copy, written decomposed by another tool, is the same tag to a reader.
    const copy = doc.tables.tag.find((t) => t.id === result.second.id)!;
    copy.name = NFD('Zoë research');
    const [keep, drop] = [result.first.id, result.second.id].sort();

    const target = openMemoryTree();
    importJson(target, doc);
    expect(tags.list(target).map((t) => [t.id, t.name])).toEqual([[keep, NFC('Zoë research')]]);
    expect(tagLinks.listFor(target, 'person', result.person.id).map((l) => l.tag_id)).toEqual([
      keep,
    ]);
    expect(tagLinks.listFor(target, 'person', result.other.id).map((l) => l.tag_id)).toEqual([
      keep,
    ]);
    expect(JSON.parse(meta.get(target, 'nfc_merged_ids') ?? '[]')).toEqual([drop]);
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
