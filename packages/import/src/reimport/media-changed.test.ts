import { openTree, undoLast, type MediaRow, type TreeStore } from '@open-ancestry/db';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../../../fixtures/temp-dir';
import { importGedcom } from '../import';
import { TODAY, ged } from '../test-helpers';
import { applyReimport, closeReimport, prepareReimport, type ReimportSession } from './index';

/*
 * #75, the three-way case: a media item the tree already has a file for,
 * whose bytes differ in a later export. The file the last import brought is
 * the base: only the export changed it, offer the new file; only the tree
 * changed it, keep the tree's; both changed, ask, keeping the tree's unless
 * ticked.
 */

const enc = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash('sha256').update(enc(text)).digest('hex');

/** A letter scan (Ancestry _OID 222) at scans/letter.jpg. */
const EXPORT = ged(
  '0 @I1@ INDI',
  '1 NAME Ada /Vale/',
  '1 SEX F',
  '1 BIRT',
  '2 DATE 3 MAR 1851',
  '2 PLAC Millbrook',
  '1 OBJE @O1@',
  '0 @O1@ OBJE',
  '1 FILE scans/letter.jpg',
  '2 TITL Letter',
  '1 _OID 222',
);
const exportWith = (letter: string, place = 'Millbrook') =>
  zipSync({
    'gedcom.ged': enc(EXPORT.replace('2 PLAC Millbrook', `2 PLAC ${place}`)),
    'scans/letter.jpg': enc(letter),
  });

let tmp: string;
let dir: string;
let store: TreeStore;

beforeEach(async () => {
  tmp = makeTempDir('oa-reimport-changed-');
  dir = join(tmp, 'Vale.oatree');
  await importGedcom({ gedzip: exportWith('LETTER V1') }, { dir }, { today: TODAY });
  store = openTree(dir);
});
afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

const letter = () => store.db.prepare('SELECT * FROM media').get() as MediaRow;
const fileOf = (m: MediaRow) =>
  readFileSync(join(dir, 'media', ...m.local_path!.split('/')), 'utf8');
const mediaChanges = (session: ReimportSession) =>
  session.diff.people
    .flatMap((p) => p.changes)
    .filter((c) => c.kind.startsWith('media.'))
    .map((c) => ({
      kind: c.kind,
      conflict: c.conflict,
      defaultAccept: c.defaultAccept,
      applicable: c.applicable,
    }));
const replaceIds = (session: ReimportSession) =>
  new Set(
    session.diff.people
      .flatMap((p) => p.changes)
      .filter((c) => c.kind === 'media.replace')
      .map((c) => c.id),
  );

/** The user swaps the tree's letter for another scan, as attaching a file would. */
function replaceInTree(text: string) {
  mkdirSync(join(dir, 'media', 'scans'), { recursive: true });
  writeFileSync(join(dir, 'media', 'scans', 'mine.jpg'), text);
  const id = letter().id;
  store.transact('Replace file', (tx) =>
    tx.update('media', id, {
      local_path: 'scans/mine.jpg',
      sha256: sha(text),
      byte_size: text.length,
    }),
  );
}

async function reimport(text: string, place?: string) {
  return prepareReimport(store, { gedzip: exportWith(text, place) }, { today: TODAY });
}

describe('re-importing media whose bytes changed (#75)', () => {
  it('offers the new file when only the export changed it', async () => {
    const session = await reimport('LETTER V2');
    expect(mediaChanges(session)).toEqual([
      { kind: 'media.replace', conflict: undefined, defaultAccept: true, applicable: true },
    ]);
    closeReimport(session);
  });

  it('replaces the file when applied, keeping the old one on disk for undo', async () => {
    const before = letter();
    const session = await reimport('LETTER V2');
    const result = applyReimport(store, session, replaceIds(session), 'Re-import');
    closeReimport(session);
    const after = letter();
    expect(after.id).toBe(before.id);
    expect(after.sha256).toBe(sha('LETTER V2'));
    expect(after.byte_size).toBe('LETTER V2'.length);
    expect(fileOf(after)).toBe('LETTER V2');
    // Files are never overwritten: the old bytes stay where the old row pointed.
    expect(after.local_path).not.toBe(before.local_path);
    expect(fileOf(before)).toBe('LETTER V1');
    expect(result.media.copied).toEqual([before.id]);

    undoLast(store);
    expect(letter()).toMatchObject({ local_path: before.local_path, sha256: before.sha256 });
    expect(fileOf(letter())).toBe('LETTER V1');
  });

  it('offers nothing when the export has the same bytes as the last import', async () => {
    const session = await reimport('LETTER V1');
    expect(mediaChanges(session)).toEqual([]);
    closeReimport(session);
  });

  it("keeps the tree's file when only the tree changed it", async () => {
    replaceInTree('MY BETTER SCAN');
    const session = await reimport('LETTER V1');
    expect(mediaChanges(session)).toEqual([]);
    closeReimport(session);
  });

  it("asks when both changed it, keeping the tree's file unless ticked", async () => {
    replaceInTree('MY BETTER SCAN');
    const session = await reimport('LETTER V2');
    expect(mediaChanges(session)).toEqual([
      {
        kind: 'media.replace',
        conflict: 'local-edit',
        defaultAccept: false,
        applicable: true,
      },
    ]);
    // Ticked anyway: the export's file replaces the tree's.
    applyReimport(store, session, replaceIds(session), 'Re-import');
    closeReimport(session);
    expect(letter().sha256).toBe(sha('LETTER V2'));
    expect(fileOf(letter())).toBe('LETTER V2');
  });

  it('treats a file attached in the tree to an imported placeholder as a tree change', async () => {
    // The first import had no file for the letter; the user attached one.
    store.close();
    rmSync(dir, { recursive: true, force: true });
    await importGedcom(
      { gedzip: zipSync({ 'gedcom.ged': enc(EXPORT) }) },
      { dir },
      { today: TODAY },
    );
    store = openTree(dir);
    expect(letter().sha256).toBeNull();
    replaceInTree('ATTACHED HERE');
    const session = await reimport('LETTER V2');
    expect(mediaChanges(session)).toEqual([
      {
        kind: 'media.replace',
        conflict: 'local-edit',
        defaultAccept: false,
        applicable: true,
      },
    ]);
    closeReimport(session);
  });

  it("asks, keeping the tree's file, when there is no history of where the file came from", async () => {
    // A row neither imported nor logged: no import-time version to compare with.
    store.db.prepare('UPDATE media SET import_batch_id = NULL').run();
    const session = await reimport('LETTER V2');
    expect(mediaChanges(session)).toEqual([
      {
        kind: 'media.replace',
        conflict: 'local-edit',
        defaultAccept: false,
        applicable: true,
      },
    ]);
    closeReimport(session);
  });

  it('takes an applied re-import as the new base', async () => {
    const first = await reimport('LETTER V2');
    applyReimport(store, first, replaceIds(first), 'Re-import');
    closeReimport(first);
    // The same export again: nothing changed since that re-import.
    const again = await reimport('LETTER V2');
    expect(mediaChanges(again)).toEqual([]);
    closeReimport(again);
    // A newer export is a plain update, not a conflict with the tree.
    const newer = await reimport('LETTER V3');
    expect(mediaChanges(newer)).toEqual([
      { kind: 'media.replace', conflict: undefined, defaultAccept: true, applicable: true },
    ]);
    closeReimport(newer);
  });

  it("settles a declined file: the export's bytes become the base (#224)", async () => {
    const declined = await reimport('LETTER V2');
    applyReimport(store, declined, new Set(), 'Re-import');
    closeReimport(declined);
    expect(fileOf(letter())).toBe('LETTER V1');
    // The same export again: the user already said no to these bytes.
    const again = await reimport('LETTER V2');
    expect(mediaChanges(again)).toEqual([]);
    closeReimport(again);
    // Newer bytes against a file the user kept over the export's: ask.
    const newer = await reimport('LETTER V3');
    expect(mediaChanges(newer)).toEqual([
      { kind: 'media.replace', conflict: 'local-edit', defaultAccept: false, applicable: true },
    ]);
    closeReimport(newer);
  });

  it('reads the edit history for media the stored baseline does not hold', async () => {
    // A re-import that stores a baseline for Ada's birth, and none for the letter.
    const first = await reimport('LETTER V1', 'Millbrook, Westmere');
    applyReimport(
      store,
      first,
      new Set(first.diff.people.flatMap((p) => p.changes).map((c) => c.id)),
      'Re-import',
    );
    closeReimport(first);
    expect(
      store.db.prepare("SELECT value FROM meta WHERE key LIKE 'reimport.base:%'").pluck().all(),
    ).toEqual([expect.not.stringContaining('media|')]);
    // Unchanged in the tree since: the export's new bytes are a plain update.
    const plain = await reimport('LETTER V2', 'Millbrook, Westmere');
    expect(mediaChanges(plain)).toEqual([
      { kind: 'media.replace', conflict: undefined, defaultAccept: true, applicable: true },
    ]);
    closeReimport(plain);
    // Replaced here since: the history's first edit gives the base, so it is a conflict.
    replaceInTree('MY BETTER SCAN');
    const both = await reimport('LETTER V2', 'Millbrook, Westmere');
    expect(mediaChanges(both)).toEqual([
      { kind: 'media.replace', conflict: 'local-edit', defaultAccept: false, applicable: true },
    ]);
    closeReimport(both);
  });

  it('stores a base only for a replacement left undone: declined, not applied', async () => {
    const stored = () =>
      (
        store.db
          .prepare("SELECT value FROM meta WHERE key LIKE 'reimport.base:%'")
          .pluck()
          .all() as string[]
      ).filter((v) => v.includes('media|')).length;
    const applied = await reimport('LETTER V2');
    applyReimport(store, applied, replaceIds(applied), 'Re-import');
    closeReimport(applied);
    // Its media row write settles it; a stored image would only repeat it.
    expect(stored()).toBe(0);
    const declined = await reimport('LETTER V3');
    applyReimport(store, declined, new Set(), 'Re-import');
    closeReimport(declined);
    expect(stored()).toBe(1);
  });

  it('offers a ticked replacement again, ticked, when its copy was refused', async () => {
    const session = await reimport('LETTER V2');
    // Too large to copy: the user wanted it, but it did not happen.
    const result = applyReimport(store, session, replaceIds(session), 'Re-import', {
      maxMediaBytes: 1,
    });
    closeReimport(session);
    expect(result.media.refused).toEqual([letter().id]);
    expect(fileOf(letter())).toBe('LETTER V1');
    const again = await reimport('LETTER V2');
    expect(mediaChanges(again)).toEqual([
      { kind: 'media.replace', conflict: undefined, defaultAccept: true, applicable: true },
    ]);
    closeReimport(again);
  });
});
