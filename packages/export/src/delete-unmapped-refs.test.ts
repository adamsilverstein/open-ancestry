import { exportJsonString, persons, undoLast, type TreeStore } from '@open-ancestry/db';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildGedcomExport, buildGedzipExport } from './index';
import { TODAY, ged, importInto, pid, value } from './test-helpers';

/*
 * Issue #245: a person's only pointer to a NOTE, OBJE or SOUR record can sit
 * inside an ASSO or custom subtree, kept as unmapped text rather than a link.
 * Deleting the person must take those records too (unless something else
 * still points at them), or every unprivatized export writes them on.
 */
const tree = ged(
  '0 @I1@ INDI',
  '1 NAME Ozias /Canarydeleted/',
  '1 ASSO @I2@',
  '2 RELA Friend',
  '2 NOTE @N5@',
  '2 SOUR @S9@',
  '1 _CUSTOM',
  '2 OBJE @O7@',
  '2 NOTE @N6@',
  '2 OBJE @O8@',
  '0 @I2@ INDI',
  '1 NAME Petra /Keeper/',
  '1 OBJE @O8@',
  '0 @I3@ INDI',
  '1 NAME Quinn /Sharer/',
  '1 _CUSTOM',
  '2 NOTE @N6@',
  '0 @N5@ NOTE Canarynote only Ozias pointed to',
  '0 @N6@ NOTE Shared note Quinn still points to',
  '0 @O7@ OBJE',
  '1 FILE photos/canaryphoto.jpg',
  '2 FORM jpg',
  '2 TITL Canaryphototitle',
  '0 @O8@ OBJE',
  '1 FILE photos/petra.jpg',
  '2 FORM jpg',
  '2 TITL Petra at the shore',
  '0 @S9@ SOUR',
  '1 TITL Canarysource letters',
);

const canaries = (text: string) => text.match(/canary\w*/gi) ?? [];
const count = (store: TreeStore, table: string) =>
  value<number>(store, `SELECT count(*) FROM ${table}`);

describe('deleting a person whose only pointers were imported text (#245)', () => {
  it('deletes the NOTE, OBJE and SOUR records only they pointed to, and undo restores them', async () => {
    const store = await importInto(tree);
    const before = {
      note: count(store, 'note'),
      media: count(store, 'media'),
      source: count(store, 'source'),
    };
    expect(before).toEqual({ note: 2, media: 2, source: 1 });

    store.transact('Delete Ozias', (tx) => persons.delete(tx, pid(store, '@I1@')));
    expect(count(store, 'note')).toBe(1);
    expect(value(store, 'SELECT text FROM note')).toBe('Shared note Quinn still points to');
    // Petra links to her photo, and Quinn's imported text points to the shared note: both stay.
    expect(count(store, 'media')).toBe(1);
    expect(value(store, 'SELECT title FROM media')).toBe('Petra at the shore');
    expect(count(store, 'source')).toBe(0);

    for (const version of ['5.5.1', '7'] as const) {
      expect(canaries(buildGedcomExport(store, { version, now: TODAY }).text), version).toEqual([]);
    }
    const zip = unzipSync(buildGedzipExport(store, { now: TODAY }).bytes);
    expect(canaries(Object.keys(zip).join('\n'))).toEqual([]);
    expect(canaries(new TextDecoder().decode(zip['gedcom.ged']))).toEqual([]);
    expect(canaries(exportJsonString(store, { history: false }))).toEqual([]);

    undoLast(store);
    expect({
      note: count(store, 'note'),
      media: count(store, 'media'),
      source: count(store, 'source'),
    }).toEqual(before);
    store.close();
  });
});
