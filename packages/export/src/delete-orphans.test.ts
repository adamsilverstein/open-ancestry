import { BulkWriter, exportJsonString, openMemoryTree, persons } from '@open-ancestry/db';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildGedcomExport, buildGedzipExport } from './index';
import { TODAY, ged, importInto, pid } from './test-helpers';

/*
 * Issue #226: a deleted person's own notes, photos and citations stayed in
 * the tree and were still exported. Every secret carries "Canary".
 */

const FILE = ged(
  '0 @I1@ INDI',
  '1 NAME Pat /Ash/',
  '1 BIRT',
  '2 DATE 1890',
  '1 NOTE Canary diary entry',
  '1 OBJE',
  '2 FILE photos/canary-portrait.jpg',
  '3 FORM jpg',
  '2 TITL Canary portrait',
  '1 SOUR @S1@',
  '2 PAGE Canary page 3',
  '0 @I2@ INDI',
  '1 NAME Bram /Vale/',
  '1 NOTE Bram kept bees',
  '0 @S1@ SOUR',
  '1 TITL Canary letters',
);

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('exports after deleting a person (#226)', () => {
  it('contain none of their notes, photos, file names or citations', async () => {
    const store = await importInto(FILE);
    store.transact('Delete Pat', (tx) => persons.delete(tx, pid(store, '@I1@')));
    const outputs = {
      'GEDCOM 5.5.1': buildGedcomExport(store, { version: '5.5.1', now: TODAY }).text,
      'GEDCOM 7': buildGedcomExport(store, { version: '7', now: TODAY }).text,
      GEDZIP: Object.values(unzipSync(buildGedzipExport(store, { now: TODAY }).bytes))
        .map(decode)
        .join('\n'),
      // Without history: the delete batch's before-images keep them, so undo works.
      JSON: exportJsonString(store, { history: false }),
    };
    for (const [format, text] of Object.entries(outputs)) {
      expect(text, format).not.toMatch(/canary/i);
      expect(text, format).toContain('Bram');
    }
  });
});

describe('privatized exports (#226)', () => {
  it('never write a note or media record nothing refers to', () => {
    const store = openMemoryTree();
    const w = new BulkWriter(store);
    w.insert('person', { id: 'P1', living: 'dead' } as never);
    w.insert('person_name', { person_id: 'P1', given: 'Ivo', is_primary: 1 });
    w.insert('note', { text: 'Canary orphan note' });
    w.insert('media', {
      kind: 'photo',
      remote_url: 'https://www.ancestry.com/canary.jpg',
      title: 'Canary orphan photo',
    });
    w.commit();
    for (const version of ['5.5.1', '7'] as const) {
      const text = buildGedcomExport(store, { version, privatizeLiving: true, now: TODAY }).text;
      expect(text, version).not.toMatch(/canary/i);
      expect(text, version).toContain('Ivo');
    }
    // An unprivatized export still keeps standalone records, so nothing is lost.
    expect(buildGedcomExport(store, { version: '5.5.1', now: TODAY }).text).toContain(
      'Canary orphan note',
    );
  });
});
