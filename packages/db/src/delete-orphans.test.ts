import { describe, expect, it } from 'vitest';
import {
  BulkWriter,
  citationLinks,
  citations,
  families,
  mediaLinks,
  noteLinks,
  persons,
  refreshDerivedColumns,
  sources,
  undoLast,
  type TreeStore,
} from './index';
import { memoryTree } from './test/helpers';

/*
 * Issue #226: deleting a person (or family) left their own notes, media and
 * citations behind as orphan rows, which exports still wrote.
 */

const count = (store: TreeStore, table: string) =>
  store.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;

function personWithItems(store: TreeStore, name: string) {
  return store.transact(`Add ${name}`, (tx) => {
    const person = persons.create(tx, { names: [{ given: name }] });
    const note = tx.insert('note', { text: `${name}'s diary` });
    noteLinks.create(tx, { note_id: note.id, owner_type: 'person', owner_id: person.id });
    const photo = tx.insert('media', {
      kind: 'photo',
      local_path: `photos/${name}.jpg`,
      title: `${name} portrait`,
    });
    mediaLinks.create(tx, { media_id: photo.id, owner_type: 'person', owner_id: person.id });
    tx.update('person', person.id, { primary_media_id: photo.id });
    const source = sources.create(tx, { title: `${name}'s letters` });
    const citation = citations.create(tx, { source_id: source.id, page: `${name} p. 3` });
    citationLinks.create(tx, {
      citation_id: citation.id,
      owner_type: 'person',
      owner_id: person.id,
    });
    return { person, note, photo, source, citation };
  }).result;
}

describe('deleting a person (#226)', () => {
  it('deletes notes, media, citations and sources that were only theirs, and undo restores them', () => {
    const store = memoryTree();
    const keep = personWithItems(store, 'Bram');
    const gone = personWithItems(store, 'Pat');
    const before = ['note', 'media', 'citation', 'source'].map((t) => count(store, t));

    store.transact('Delete Pat', (tx) => persons.delete(tx, gone.person.id));
    for (const [table, id] of [
      ['note', gone.note.id],
      ['media', gone.photo.id],
      ['citation', gone.citation.id],
      ['source', gone.source.id],
    ] as const) {
      expect(store.getRow(table, id), table).toBeUndefined();
    }
    // Bram's items are untouched.
    expect(store.getRow('note', keep.note.id)).toBeDefined();
    expect(store.getRow('media', keep.photo.id)).toBeDefined();

    undoLast(store);
    expect(['note', 'media', 'citation', 'source'].map((t) => count(store, t))).toEqual(before);
    expect(store.getRow('person', gone.person.id)?.primary_media_id).toBe(gone.photo.id);
    store.close();
  });

  it('keeps a note, photo, citation or source someone else still uses', () => {
    const store = memoryTree();
    const pat = personWithItems(store, 'Pat');
    const { result: other } = store.transact('Share', (tx) => {
      const other = persons.create(tx, { names: [{ given: 'Ivo' }] });
      noteLinks.create(tx, { note_id: pat.note.id, owner_type: 'person', owner_id: other.id });
      tx.update('person', other.id, { primary_media_id: pat.photo.id });
      citationLinks.create(tx, {
        citation_id: pat.citation.id,
        owner_type: 'person',
        owner_id: other.id,
      });
      return other;
    });
    store.transact('Delete Pat', (tx) => persons.delete(tx, pat.person.id));
    expect(store.getRow('note', pat.note.id)).toBeDefined();
    expect(store.getRow('media', pat.photo.id)).toBeDefined();
    expect(store.getRow('citation', pat.citation.id)).toBeDefined();
    expect(store.getRow('source', pat.source.id)).toBeDefined();
    expect(store.getRow('person', other.id)?.primary_media_id).toBe(pat.photo.id);
    store.close();
  });

  it("keeps a NOTE record another person's imported text still points to", () => {
    const store = memoryTree();
    const w = new BulkWriter(store);
    const batch = w.insert('import_batch', { file_name: 'tree.ged' });
    w.insert('raw_record', {
      import_batch_id: batch,
      seq: 1,
      gedcom_tag: 'INDI',
      xref: '@I1@',
      raw_text: '0 @I1@ INDI\n1 ASSO @I2@\n2 NOTE @N3@\n',
    });
    w.commit();
    const { pat, note } = store.transact('Add', (tx) => {
      const pat = persons.create(tx, { names: [{ given: 'Pat' }] });
      const note = tx.insert('note', { text: 'shared note', external_id: '@N3@' });
      noteLinks.create(tx, { note_id: note.id, owner_type: 'person', owner_id: pat.id });
      return { pat, note };
    }).result;
    store.transact('Delete Pat', (tx) => persons.delete(tx, pat.id));
    expect(store.getRow('note', note.id)).toBeDefined();
    store.close();
  });

  it('keeps a source that has other citations', () => {
    const store = memoryTree();
    const pat = personWithItems(store, 'Pat');
    store.transact('Second citation', (tx) =>
      citations.create(tx, { source_id: pat.source.id, page: 'p. 9' }),
    );
    store.transact('Delete Pat', (tx) => persons.delete(tx, pat.person.id));
    expect(store.getRow('citation', pat.citation.id)).toBeUndefined();
    expect(store.getRow('source', pat.source.id)).toBeDefined();
    store.close();
  });

  it('deletes a note on a citation together with the citation', () => {
    const store = memoryTree();
    const pat = personWithItems(store, 'Pat');
    const { result: note } = store.transact('Note on citation', (tx) => {
      const note = tx.insert('note', { text: 'transcription' });
      noteLinks.create(tx, { note_id: note.id, owner_type: 'citation', owner_id: pat.citation.id });
      return note;
    });
    store.transact('Delete Pat', (tx) => persons.delete(tx, pat.person.id));
    expect(store.getRow('note', note.id)).toBeUndefined();
    store.close();
  });
});

describe('deleting a family (#226)', () => {
  it('deletes a note that was only on the family', () => {
    const store = memoryTree();
    const { result } = store.transact('Family', (tx) => {
      const family = families.create(tx, {});
      const note = tx.insert('note', { text: 'married in secret' });
      noteLinks.create(tx, { note_id: note.id, owner_type: 'family', owner_id: family.id });
      return { family, note };
    });
    store.transact('Delete family', (tx) => families.delete(tx, result.family.id));
    expect(store.getRow('note', result.note.id)).toBeUndefined();
    undoLast(store);
    expect(store.getRow('note', result.note.id)).toBeDefined();
    store.close();
  });
});

describe('cleaning up orphans left by earlier deletes (#226)', () => {
  it('removes unlinked inline notes, media and citations, keeping standalone imported records', () => {
    const store = memoryTree();
    const w = new BulkWriter(store);
    const source = w.insert('source', { title: 'Parish register' });
    w.insert('citation', { source_id: source, page: 'orphan page' });
    w.insert('note', { text: 'orphan note' });
    w.insert('media', { kind: 'photo', title: 'orphan photo' });
    // Imported NOTE and OBJE records may stand alone.
    w.insert('note', { text: 'standalone note', external_id: '@N1@' });
    w.insert('media', { kind: 'photo', title: 'standalone photo', external_id: '@O1@' });
    w.commit();
    store.db.prepare('DELETE FROM derived_state').run();

    refreshDerivedColumns(store);
    const texts = (sql: string) => store.db.prepare(sql).pluck().all();
    expect(texts('SELECT text FROM note')).toEqual(['standalone note']);
    expect(texts('SELECT title FROM media')).toEqual(['standalone photo']);
    expect(count(store, 'citation')).toBe(0);
    // A source is shared reference data: kept even with no citations left.
    expect(count(store, 'source')).toBe(1);
    // Not an edit: nothing in History.
    expect(count(store, 'change_batch')).toBe(0);
    store.close();
  });

  it('drops quoted lines from stored import reports', () => {
    const store = memoryTree();
    const w = new BulkWriter(store);
    w.insert('import_batch', {
      file_name: 'tree.ged',
      counts_json: JSON.stringify({
        persons: 1,
        unmapped: [
          { path: 'OBJE.FILE', tag: 'FILE', count: 1, example: { line: 9, text: '2 FILE x.jpg' } },
        ],
      }),
      warnings_json: JSON.stringify([{ code: 'bad_date', line: 4, message: 'Odd date for Ivo' }]),
    });
    w.commit();
    store.db.prepare('DELETE FROM derived_state').run();

    refreshDerivedColumns(store);
    const row = store.db.prepare('SELECT counts_json, warnings_json FROM import_batch').get() as {
      counts_json: string;
      warnings_json: string;
    };
    expect(JSON.parse(row.counts_json)).toEqual({
      persons: 1,
      unmapped: [{ path: 'OBJE.FILE', tag: 'FILE', count: 1 }],
    });
    expect(JSON.parse(row.warnings_json)).toEqual([{ code: 'bad_date', line: 4 }]);
    store.close();
  });

  it('removes an imported NOTE record whose link a pre-fix delete removed, keeping standalone ones', () => {
    const store = memoryTree();
    const w = new BulkWriter(store);
    w.insert('note', { text: 'standalone note', external_id: '@N2@' });
    w.insert('media', { kind: 'photo', title: 'standalone photo', external_id: '@O1@' });
    w.commit();
    // A delete from before #226: the link went, the NOTE record stayed.
    const { note, link } = store.transact('Add', (tx) => {
      const person = persons.create(tx, { names: [{ given: 'Ivo' }] });
      const note = tx.insert('note', { text: 'their note record', external_id: '@N1@' });
      const link = noteLinks.create(tx, {
        note_id: note.id,
        owner_type: 'person',
        owner_id: person.id,
      });
      return { note, link };
    }).result;
    store.transact('Old delete', (tx) => tx.delete('note_link', link.id));
    store.db.prepare('DELETE FROM derived_state').run();

    refreshDerivedColumns(store);
    const texts = (sql: string) => store.db.prepare(sql).pluck().all();
    expect(texts('SELECT text FROM note')).toEqual(['standalone note']);
    expect(texts('SELECT title FROM media')).toEqual(['standalone photo']);
    expect(store.getRow('note', note.id)).toBeUndefined();
    // Undoing the old delete now says why it cannot.
    expect(() => undoLast(store)).toThrow(/cleaned up/);
    store.close();
  });

  it('keeps NOTE and OBJE records a surviving record still points to in its imported text', () => {
    // review-21's probe: @I1@ points to them from an ASSO NOTE and a _CUSTOM subtree, kept
    // as raw text rather than links, and an old delete of someone else's link to them.
    const store = memoryTree();
    const w = new BulkWriter(store);
    const batch = w.insert('import_batch', { file_name: 'tree.ged' });
    w.insert('raw_record', {
      import_batch_id: batch,
      seq: 1,
      gedcom_tag: 'INDI',
      xref: '@I1@',
      raw_text:
        '0 @I1@ INDI\n1 NAME Ada /Vale/\n1 ASSO @I2@\n2 RELA Friend\n2 NOTE @N3@\n1 _CUSTOM\n2 OBJE @O3@\n',
    });
    w.commit();
    const { link } = store.transact('Add', (tx) => {
      const person = persons.create(tx, { names: [{ given: 'Ivo' }] });
      tx.insert('media', { kind: 'photo', title: 'shared photo', external_id: '@O3@' });
      const note = tx.insert('note', { text: 'shared note', external_id: '@N3@' });
      const link = noteLinks.create(tx, {
        note_id: note.id,
        owner_type: 'person',
        owner_id: person.id,
      });
      return { link };
    }).result;
    store.transact('Old delete', (tx) => tx.delete('note_link', link.id));
    store.db.prepare('DELETE FROM derived_state').run();

    refreshDerivedColumns(store);
    const texts = (sql: string) => store.db.prepare(sql).pluck().all();
    expect(texts('SELECT text FROM note')).toEqual(['shared note']);
    expect(texts('SELECT title FROM media')).toEqual(['shared photo']);
    store.close();
  });
});
