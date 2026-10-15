import { openTree, undoLast, type TreeStore } from '@open-ancestry/db';
import { zipSync } from 'fflate';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importGedcom } from '../import';
import { TODAY, ged } from '../test-helpers';
import { applyReimport, closeReimport, prepareReimport, type ReimportSession } from './index';

/*
 * #75: re-importing a GEDZIP (or a GEDCOM with a media folder) copies the
 * export's new media files into the tree, with the importer's rules.
 */

const enc = (text: string) => new TextEncoder().encode(text);
let tmp: string;
let dir: string;
let store: TreeStore;

/**
 * The tree's first export: Ada with a placeholder photo (Ancestry _OID 111,
 * no file) and a scan whose file the tree already has (old.jpg, "OLD").
 */
const FIRST = ged(
  '0 @I1@ INDI',
  '1 NAME Ada /Vale/',
  '1 SEX F',
  '1 OBJE @O1@',
  '1 OBJE @O2@',
  '0 @O1@ OBJE',
  '1 FILE https://mediasvc.ancestry.com/v2/image/namespaces/1093/media/111',
  '2 TITL Portrait',
  '1 _OID 111',
  '0 @O2@ OBJE',
  '1 FILE scans/old.jpg',
  '2 TITL Old scan',
);

/**
 * The later export: the placeholder now has a file, a new photo, and the old
 * scan again under another name and an _OID of its own.
 */
const LATER = ged(
  '0 @I51@ INDI',
  '1 NAME Ada /Vale/',
  '1 SEX F',
  '1 OBJE @O51@',
  '1 OBJE @O52@',
  '1 OBJE @O53@',
  '0 @O51@ OBJE',
  '1 FILE photos/portrait.jpg',
  '2 TITL Portrait',
  '1 _OID 111',
  '0 @O52@ OBJE',
  '1 FILE photos/new.jpg',
  '2 TITL Wedding',
  '0 @O53@ OBJE',
  '1 FILE copies/old-again.jpg',
  '2 TITL Old scan',
  '1 _OID 333',
);
const LATER_FILES = {
  'photos/portrait.jpg': 'PORTRAIT',
  'photos/new.jpg': 'NEW',
  'copies/old-again.jpg': 'OLD',
};

function laterZip(files: Record<string, string> = LATER_FILES) {
  return zipSync({
    'gedcom.ged': enc(LATER),
    ...Object.fromEntries(Object.entries(files).map(([path, text]) => [path, enc(text)])),
  });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'oa-reimport-media-'));
  dir = join(tmp, 'Vale.oatree');
  await importGedcom(
    { gedzip: zipSync({ 'gedcom.ged': enc(FIRST), 'scans/old.jpg': enc('OLD') }) },
    { dir },
    { today: TODAY },
  );
  store = openTree(dir);
});
afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

const mediaRows = () =>
  store.db
    .prepare('SELECT title, local_path, ancestry_oid FROM media ORDER BY title, local_path')
    .all();
const changesOf = (session: ReimportSession) =>
  session.diff.people
    .flatMap((p) => p.changes)
    .map((c) => ({ kind: c.kind, title: 'title' in c ? c.title : undefined }));
const acceptAll = (session: ReimportSession) =>
  new Set(
    session.diff.people
      .flatMap((p) => p.changes)
      .filter((c) => c.applicable)
      .map((c) => c.id),
  );

describe('re-importing media files (#75)', () => {
  it('offers new photos and files for placeholders, but not bytes the tree already has', async () => {
    const session = await prepareReimport(store, { gedzip: laterZip() }, { today: TODAY });
    expect(changesOf(session)).toEqual([
      { kind: 'media.file', title: 'Portrait' },
      { kind: 'media.add', title: 'Wedding' },
    ]);
    expect(session.report.media).toMatchObject({ linked: 3, rejected: 0, missing: [] });
    closeReimport(session);
  });

  it('copies the files into media/ when applied, and lists them for thumbnails', async () => {
    const session = await prepareReimport(store, { gedzip: laterZip() }, { today: TODAY });
    const result = applyReimport(store, session, acceptAll(session), 'Re-import');
    closeReimport(session);
    const media = join(dir, 'media');
    expect(readFileSync(join(media, 'photos', 'portrait.jpg'), 'utf8')).toBe('PORTRAIT');
    expect(readFileSync(join(media, 'photos', 'new.jpg'), 'utf8')).toBe('NEW');
    expect(existsSync(join(media, 'copies'))).toBe(false);
    expect(mediaRows()).toEqual([
      { title: 'Old scan', local_path: 'scans/old.jpg', ancestry_oid: null },
      // The placeholder row got its file; no second Portrait row.
      { title: 'Portrait', local_path: 'photos/portrait.jpg', ancestry_oid: '111' },
      { title: 'Wedding', local_path: 'photos/new.jpg', ancestry_oid: null },
    ]);
    expect(result.media).toEqual({
      copied: expect.arrayContaining([expect.any(String), expect.any(String)]),
      refused: [],
    });
    expect(result.media.copied).toHaveLength(2);
    // Undo takes the rows back; like attach, the copied files stay (the next import can reuse them).
    undoLast(store);
    expect(mediaRows()).toEqual([
      { title: 'Old scan', local_path: 'scans/old.jpg', ancestry_oid: null },
      { title: 'Portrait', local_path: null, ancestry_oid: '111' },
    ]);
  });

  it('keeps the export text of media matched by bytes owned by the tree row (lossless export)', async () => {
    const session = await prepareReimport(store, { gedzip: laterZip() }, { today: TODAY });
    applyReimport(store, session, acceptAll(session), 'Re-import');
    closeReimport(session);
    // @O53@ is the old scan under a new _OID: matched by its bytes, so its
    // record must point at the tree's Old scan row, not at nothing.
    const owner = store.db
      .prepare(
        "SELECT owner_type, owner_id FROM raw_record WHERE gedcom_tag = 'OBJE' AND raw_text LIKE '%old-again.jpg%'",
      )
      .get() as { owner_type: string | null; owner_id: string | null };
    const oldScan = store.db
      .prepare("SELECT id FROM media WHERE title = 'Old scan'")
      .pluck()
      .get() as string;
    expect(owner).toEqual({ owner_type: 'media', owner_id: oldScan });
  });

  it('reads files from a media folder next to a GEDCOM', async () => {
    const folder = join(tmp, 'export-media');
    for (const [path, text] of Object.entries(LATER_FILES)) {
      mkdirSync(join(folder, path, '..'), { recursive: true });
      writeFileSync(join(folder, path), text);
    }
    const session = await prepareReimport(
      store,
      { bytes: LATER },
      { today: TODAY, mediaDir: folder },
    );
    applyReimport(store, session, acceptAll(session), 'Re-import');
    closeReimport(session);
    expect(readFileSync(join(dir, 'media', 'photos', 'new.jpg'), 'utf8')).toBe('NEW');
  });

  it('keeps a different file with the same name beside the old one', async () => {
    mkdirSync(join(dir, 'media', 'photos'), { recursive: true });
    writeFileSync(join(dir, 'media', 'photos', 'new.jpg'), 'SOMETHING ELSE');
    const session = await prepareReimport(store, { gedzip: laterZip() }, { today: TODAY });
    applyReimport(store, session, acceptAll(session), 'Re-import');
    closeReimport(session);
    expect(readFileSync(join(dir, 'media', 'photos', 'new.jpg'), 'utf8')).toBe('SOMETHING ELSE');
    expect(readFileSync(join(dir, 'media', 'photos', 'new-2.jpg'), 'utf8')).toBe('NEW');
  });

  it('removes the files it copied when the apply fails', async () => {
    const session = await prepareReimport(store, { gedzip: laterZip() }, { today: TODAY });
    const transact = store.transact.bind(store);
    store.transact = ((label, fn) =>
      transact(label, (tx) => {
        fn(tx);
        throw new Error('disk on fire');
      })) as typeof store.transact;
    expect(() => applyReimport(store, session, acceptAll(session), 'Re-import')).toThrow(
      'disk on fire',
    );
    store.transact = transact;
    closeReimport(session);
    expect(existsSync(join(dir, 'media', 'photos'))).toBe(false);
    expect(mediaRows()).toHaveLength(2);
  });

  it('never writes outside the tree: a symlinked media/ refuses the copy, keeping the row', async () => {
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(join(dir, 'media'), { recursive: true });
    symlinkSync(elsewhere, join(dir, 'media'));
    const session = await prepareReimport(store, { gedzip: laterZip() }, { today: TODAY });
    const result = applyReimport(store, session, acceptAll(session), 'Re-import');
    closeReimport(session);
    expect(result.media.copied).toEqual([]);
    expect(result.media.refused).toHaveLength(2);
    expect(existsSync(join(elsewhere, 'photos'))).toBe(false);
    expect(mediaRows()).toContainEqual({ title: 'Wedding', local_path: null, ancestry_oid: null });
  });

  it('ignores archive entries that climb out of the folder', async () => {
    const zip = zipSync({
      'gedcom.ged': enc(LATER.replace('photos/new.jpg', '../new.jpg')),
      '../new.jpg': enc('NEW'),
    });
    const session = await prepareReimport(store, { gedzip: zip }, { today: TODAY });
    applyReimport(store, session, acceptAll(session), 'Re-import');
    closeReimport(session);
    expect(existsSync(join(dir, 'new.jpg'))).toBe(false);
    expect(existsSync(join(tmp, 'new.jpg'))).toBe(false);
  });
});

describe('re-import media without holding memory or the tree lock (#243 review)', () => {
  const spills = () => readdirSync(dir).filter((name) => name.startsWith('.reimport-'));

  it("keeps a GEDZIP's files in the folder it is given, not in memory, until closed", async () => {
    const session = await prepareReimport(
      store,
      { gedzip: laterZip() },
      { today: TODAY, spillDir: () => mkdtempSync(join(dir, '.reimport-')) },
    );
    expect(spills()).toHaveLength(1);
    expect(readFileSync(join(dir, spills()[0]!, 'photos', 'new.jpg'), 'utf8')).toBe('NEW');
    applyReimport(store, session, acceptAll(session), 'Re-import');
    expect(readFileSync(join(dir, 'media', 'photos', 'new.jpg'), 'utf8')).toBe('NEW');
    closeReimport(session);
    expect(spills()).toEqual([]);
  });

  it('copies files before the write transaction, and leaves none it did not use', async () => {
    const session = await prepareReimport(store, { gedzip: laterZip() }, { today: TODAY });
    const transact = store.transact.bind(store);
    let copiedFirst = false;
    store.transact = ((label, fn) => {
      copiedFirst = existsSync(join(dir, 'media', 'photos', 'new.jpg'));
      return transact(label, fn);
    }) as typeof store.transact;
    // Only the placeholder's file is accepted; the new photo is left out.
    const fileOnly = new Set(
      session.diff.people
        .flatMap((p) => p.changes)
        .filter((c) => c.kind === 'media.file')
        .map((c) => c.id),
    );
    applyReimport(store, session, fileOnly, 'Re-import');
    store.transact = transact;
    closeReimport(session);
    expect(copiedFirst).toBe(true);
    expect(readFileSync(join(dir, 'media', 'photos', 'portrait.jpg'), 'utf8')).toBe('PORTRAIT');
    expect(existsSync(join(dir, 'media', 'photos', 'new.jpg'))).toBe(false);
  });
});
