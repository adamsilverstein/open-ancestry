import { openMemoryTree, openTree, treePaths } from '@open-ancestry/db';
import { readGedzip, safeEntryPath } from '@open-ancestry/gedcom';
import { importGedcom } from '@open-ancestry/import';
import { unzipSync, zipSync } from 'fflate';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGedzipExport, exportGedzip } from './index';
import {
  TODAY,
  domainSnapshot,
  gedcom7Problems,
  ged,
  importedSnapshot,
  rows,
} from './test-helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'oa-export-'));
  dirs.push(d);
  return d;
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

const gedcom = ged(
  '0 @I1@ INDI',
  '1 NAME Odile /Fernsby/',
  '1 BIRT',
  '2 DATE 1801',
  '1 DEAT',
  '2 DATE 1870',
  '1 OBJE @O1@',
  '1 OBJE @O2@',
  '0 @O1@ OBJE',
  '1 FILE photos/odile portrait.png',
  '2 FORM png',
  '2 TITL Odile, about 1850',
  '0 @O2@ OBJE',
  '1 FILE scans/letter.jpg',
  '2 FORM jpg',
  '0 @O3@ OBJE',
  '1 FILE https://example.com/remote.jpg',
);

/** A tree on disk whose media folder holds the two files the GEDCOM names. */
async function treeWithMedia() {
  const root = tempDir();
  const archive = zipSync({
    'gedcom.ged': new TextEncoder().encode(gedcom),
    'photos/odile portrait.png': PNG,
    'scans/letter.jpg': JPG,
  });
  const dir = join(root, 'Fernsby.oatree');
  await importGedcom({ gedzip: archive }, { dir }, { today: TODAY });
  return { dir, store: openTree(dir) };
}

describe('GEDZIP export', () => {
  it('writes GEDCOM 7 as gedcom.ged plus the media files, and re-imports the same', async () => {
    const { store } = await treeWithMedia();
    const result = buildGedzipExport(store, { now: TODAY });
    expect(result.warnings).toEqual([]);
    const files = unzipSync(result.bytes);
    expect(Object.keys(files).sort()).toEqual([
      'gedcom.ged',
      'photos/odile portrait.png',
      'scans/letter.jpg',
    ]);
    expect(files['photos/odile portrait.png']).toEqual(PNG);
    const text = new TextDecoder().decode(files['gedcom.ged']);
    expect(gedcom7Problems(text)).toEqual([]);
    expect(text).toContain('1 FILE photos/odile%20portrait.png\n2 FORM image/png');

    const again = openMemoryTree();
    await importGedcom({ gedzip: result.bytes }, again, { today: TODAY });
    expect(importedSnapshot(again, { files: true })).toEqual(
      domainSnapshot(store, (_t, id) => result.xrefs.get(id)!, { files: true }),
    );
    store.close();
  });

  it('every archive entry is a safe relative path that readGedzip accepts', async () => {
    const { store } = await treeWithMedia();
    const bytes = exportGedzip(store, { now: TODAY });
    for (const name of Object.keys(unzipSync(bytes))) expect(safeEntryPath(name)).toBe(name);
    expect(readGedzip(bytes).warnings).toEqual([]);
    store.close();
  });

  it('never reads outside the media folder, even through a symlink', async () => {
    const { store, dir } = await treeWithMedia();
    const outside = join(tempDir(), 'secret.txt');
    writeFileSync(outside, 'not for export');
    const media = treePaths(dir).media;
    rmSync(join(media, 'scans', 'letter.jpg'));
    symlinkSync(outside, join(media, 'scans', 'letter.jpg'));
    const result = buildGedzipExport(store, { now: TODAY });
    const files = unzipSync(result.bytes);
    expect(Object.keys(files)).not.toContain('scans/letter.jpg');
    expect(result.warnings).toEqual([expect.stringContaining('scans/letter.jpg')]);
    store.close();
  });

  it('reports a missing media file and still writes the archive', async () => {
    const { store, dir } = await treeWithMedia();
    rmSync(join(treePaths(dir).media, 'photos'), { recursive: true });
    const result = buildGedzipExport(store, { now: TODAY });
    expect(Object.keys(unzipSync(result.bytes)).sort()).toEqual(['gedcom.ged', 'scans/letter.jpg']);
    expect(result.warnings).toEqual([expect.stringContaining('photos/odile portrait.png')]);
    store.close();
  });

  it('keeps media named like the GEDCOM file out of its way', async () => {
    const { store, dir } = await treeWithMedia();
    mkdirSync(treePaths(dir).media, { recursive: true });
    writeFileSync(join(treePaths(dir).media, 'GEDCOM.GED'), 'x');
    const id = rows<{ id: string }>(store, "SELECT id FROM media WHERE external_id = '@O2@'")[0]!
      .id;
    store.db.prepare("UPDATE media SET local_path = 'GEDCOM.GED' WHERE id = ?").run(id);
    const files = unzipSync(exportGedzip(store, { now: TODAY }));
    expect(new TextDecoder().decode(files['gedcom.ged'])).toContain('0 HEAD');
    expect(Object.keys(files)).toContain('media/GEDCOM.GED');
    store.close();
  });

  it('works for an in-memory tree with no media folder', async () => {
    const store = openMemoryTree();
    await importGedcom({ bytes: gedcom }, store, { today: TODAY });
    const files = unzipSync(exportGedzip(store, { now: TODAY }));
    expect(Object.keys(files)).toEqual(['gedcom.ged']);
  });
});
