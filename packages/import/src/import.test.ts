import { openMemoryTree, openTree } from '@open-ancestry/db';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importFile, importGedcom } from './import';
import { FIXTURES, TODAY, ged, importInto, row, rows, value } from './test-helpers';
import { ImportError } from './types';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'oa-import-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const sample = () => readFileSync(join(FIXTURES, 'ancestry-sample.ged'));
const enc = (s: string) => new TextEncoder().encode(s);

const MEDIA_GED = ged(
  '0 @I1@ INDI',
  '1 OBJE @O1@',
  '1 OBJE @O2@',
  '1 OBJE @O3@',
  '1 OBJE @O4@',
  '1 OBJE @O5@',
  '1 OBJE',
  '2 FILE photos/inline.png',
  '3 FORM png',
  '2 TITL Inline',
  '0 @O1@ OBJE',
  '1 FILE photos\\portrait.JPG',
  '2 FORM jpg',
  '3 TYPE photo',
  '0 @O2@ OBJE',
  '1 FILE C:\\Users\\someone\\Pictures\\letter.pdf',
  '1 TITL A letter',
  '1 _DATE 1901',
  '0 @O3@ OBJE',
  '1 FILE ../../etc/passwd',
  '0 @O4@ OBJE',
  '1 FILE photos/missing.jpg',
  '0 @O5@ OBJE',
  '1 FILE https://example.com/remote.mp3',
);

function writeMedia(dir: string) {
  mkdirSync(join(dir, 'photos'), { recursive: true });
  mkdirSync(join(dir, 'scans'), { recursive: true });
  writeFileSync(join(dir, 'photos', 'portrait.JPG'), 'jpeg-bytes');
  writeFileSync(join(dir, 'photos', 'inline.png'), 'png-bytes');
  writeFileSync(join(dir, 'scans', 'letter.pdf'), 'pdf-bytes');
}

describe('inputs and targets', () => {
  it('creates a new tree folder from a path, closes it, and the tree reopens', async () => {
    const file = join(tmp, 'export.ged');
    writeFileSync(file, sample());
    const dir = join(tmp, 'Ashgrove.oatree');
    const report = await importGedcom({ path: file }, { dir, name: 'Ashgrove' }, { today: TODAY });
    expect(report.treeDir).toBe(dir);
    expect(report.file).toEqual({
      name: 'export.ged',
      sha256: createHash('sha256').update(sample()).digest('hex'),
      bytes: sample().length,
    });
    const store = openTree(dir);
    try {
      expect(value(store, 'SELECT count(*) FROM person')).toBe(26);
      expect(value(store, "SELECT value FROM meta WHERE key = 'tree_name'")).toBe('Ashgrove');
      expect(value(store, 'SELECT file_name FROM import_batch')).toBe('export.ged');
    } finally {
      store.close();
    }
  });

  it('names a new tree after the Ancestry tree when no name is given', async () => {
    const dir = join(tmp, 'x.oatree');
    await importGedcom({ bytes: sample() }, { dir }, { today: TODAY });
    const store = openTree(dir);
    expect(value(store, "SELECT value FROM meta WHERE key = 'tree_name'")).toBe(
      'Ashgrove Family Tree',
    );
    store.close();
  });

  it('refuses a tree folder that already exists', async () => {
    const dir = join(tmp, 'x.oatree');
    await importGedcom({ bytes: sample() }, { dir }, { today: TODAY });
    await expect(importGedcom({ bytes: sample() }, { dir })).rejects.toMatchObject({
      code: 'tree-exists',
    });
  });

  it('refuses a tree that already has data (re-import is a later feature)', async () => {
    const { store } = await importInto(sample());
    await expect(importGedcom({ bytes: sample() }, store)).rejects.toBeInstanceOf(ImportError);
    await expect(importGedcom({ bytes: sample() }, store)).rejects.toMatchObject({
      code: 'tree-not-empty',
    });
  });

  it('refuses files over the size limit and files that are not GEDCOM', async () => {
    await expect(
      importGedcom({ bytes: sample() }, openMemoryTree(), { maxBytes: 100 }),
    ).rejects.toMatchObject({ code: 'too-large' });
    await expect(
      importGedcom({ bytes: enc('just some text\nnothing else\n') }, openMemoryTree()),
    ).rejects.toMatchObject({ code: 'not-gedcom' });
    await expect(importGedcom({ bytes: new Uint8Array() }, openMemoryTree())).rejects.toMatchObject(
      {
        code: 'not-gedcom',
      },
    );
    await expect(
      importGedcom({ path: join(tmp, 'nope.ged') }, openMemoryTree()),
    ).rejects.toMatchObject({
      code: 'read-failed',
    });
    await expect(
      importGedcom({ gedzip: enc('PK not a zip') }, openMemoryTree()),
    ).rejects.toMatchObject({ code: 'invalid-gedzip' });
  });

  it('removes a tree folder it created when the import is aborted', async () => {
    const controller = new AbortController();
    const dir = join(tmp, 'aborted.oatree');
    const promise = importGedcom(
      { bytes: readFileSync(join(FIXTURES, 'generated/synthetic-1000.ged')) },
      { dir },
      {
        signal: controller.signal,
        onProgress: (phase, done) => {
          if (phase === 'map' && done > 0) controller.abort();
        },
      },
    );
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(existsSync(dir)).toBe(false);
  });

  it('removes only what it created in an existing folder, so a retry works', async () => {
    const dir = join(tmp, 'existing.oatree');
    mkdirSync(join(dir, 'media'), { recursive: true });
    writeFileSync(join(dir, 'keep.txt'), 'mine');
    writeFileSync(join(dir, 'media', 'mine.jpg'), 'mine');
    const media = join(tmp, 'media-src');
    writeMedia(media);
    const controller = new AbortController();
    await expect(
      importGedcom(
        { bytes: MEDIA_GED },
        { dir },
        {
          mediaDir: media,
          signal: controller.signal,
          onProgress: (phase) => {
            if (phase === 'finalize') controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(readdirSync(dir).sort()).toEqual(['keep.txt', 'media']);
    expect(readdirSync(join(dir, 'media'))).toEqual(['mine.jpg']);

    const report = await importGedcom({ bytes: MEDIA_GED }, { dir }, { mediaDir: media });
    expect(report.media.linked).toBe(3);
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
  });

  it('rolls back an in-memory tree when aborted before starting', async () => {
    const store = openMemoryTree();
    await expect(
      importGedcom({ bytes: sample() }, store, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(value(store, 'SELECT count(*) FROM person')).toBe(0);
    expect(store.db.inTransaction).toBe(false);
  });

  it('reports progress through every phase', async () => {
    const onProgress = vi.fn();
    await importGedcom({ bytes: sample() }, openMemoryTree(), { onProgress, today: TODAY });
    const phases = [...new Set(onProgress.mock.calls.map((c) => c[0]))];
    expect(phases).toEqual(['read', 'parse', 'map', 'finalize', 'commit', 'done']);
    expect(onProgress).toHaveBeenCalledWith('map', 49, 49);
  });

  it('caps stored warnings but counts them all', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `1 FAMC @F${i}@`);
    const { report } = await importInto(ged('0 @I1@ INDI', ...lines), { maxWarnings: 5 });
    expect(report.warnings).toHaveLength(5);
    expect(report.warningCount).toBe(30);
  });

  it('records timings', async () => {
    const { report } = await importInto(sample());
    expect(report.timings.total).toBeGreaterThanOrEqual(report.timings.map);
    expect(Object.keys(report.timings)).toEqual(['read', 'parse', 'map', 'commit', 'total']);
  });
});

describe('media', () => {
  it('links local files from a media folder by relative path and copies them into the tree', async () => {
    const media = join(tmp, 'media-src');
    writeMedia(media);
    const dir = join(tmp, 'm.oatree');
    const report = await importGedcom(
      { bytes: MEDIA_GED },
      { dir },
      { mediaDir: media, today: TODAY },
    );

    const store = openTree(dir);
    try {
      const all = rows<Record<string, unknown>>(
        store,
        'SELECT external_id, kind, mime, local_path, remote_url, title, date_text, sha256, byte_size FROM media ORDER BY external_id',
      );
      expect(all).toEqual([
        {
          external_id: null,
          kind: 'photo',
          mime: 'image/png',
          local_path: 'photos/inline.png',
          remote_url: null,
          title: 'Inline',
          date_text: null,
          sha256: createHash('sha256').update('png-bytes').digest('hex'),
          byte_size: 9,
        },
        expect.objectContaining({
          external_id: '@O1@',
          kind: 'photo',
          mime: 'image/jpeg',
          local_path: 'photos/portrait.JPG',
          byte_size: 10,
        }),
        // Absolute Windows path: matched by file name.
        expect.objectContaining({
          external_id: '@O2@',
          kind: 'document',
          mime: 'application/pdf',
          local_path: 'scans/letter.pdf',
          title: 'A letter',
          date_text: '1901',
        }),
        expect.objectContaining({ external_id: '@O3@', local_path: null, remote_url: null }),
        expect.objectContaining({
          external_id: '@O4@',
          local_path: null,
          sha256: null,
        }),
        expect.objectContaining({
          external_id: '@O5@',
          kind: 'audio',
          mime: 'audio/mpeg',
          remote_url: 'https://example.com/remote.mp3',
        }),
      ]);
      expect(readFileSync(join(dir, 'media', 'photos', 'portrait.JPG'), 'utf8')).toBe('jpeg-bytes');
      expect(readFileSync(join(dir, 'media', 'scans', 'letter.pdf'), 'utf8')).toBe('pdf-bytes');
      expect(value(store, 'SELECT count(*) FROM media_link')).toBe(6);
      expect(
        rows<{ line: string }>(store, "SELECT line FROM unmapped_line WHERE path = 'OBJE.FILE'"),
      ).toEqual([{ line: '1 FILE ../../etc/passwd' }, { line: '1 FILE photos/missing.jpg' }]);
    } finally {
      store.close();
    }
    expect(report.media).toEqual({
      linked: 3,
      remote: 1,
      missing: [{ path: 'photos/missing.jpg', line: 26, xref: '@O4@' }],
      rejected: 1,
    });
    expect(report.warnings.map((w) => w.code)).toEqual(['media-unsafe-path', 'media-missing']);
    // The unsafe path and the missing file are reported under media only (issue #121), not
    // as unmapped tags; their FILE lines are still kept (unmapped_line) for export.
    expect(report.unmapped).toEqual([]);
    expect(report.lines.mapped + report.lines.preserved).toBe(report.lines.total);
  });

  it('links media from a GEDZIP archive', async () => {
    const zip = zipSync({
      'gedcom.ged': enc(MEDIA_GED),
      'photos/portrait.JPG': enc('jpeg-bytes'),
      'photos/inline.png': enc('png-bytes'),
      'scans/letter.pdf': enc('pdf-bytes'),
    });
    const dir = join(tmp, 'z.oatree');
    const report = await importGedcom(
      { gedzip: zip, fileName: 'family.gdz' },
      { dir },
      { today: TODAY },
    );
    expect(report.format).toBe('gedzip');
    expect(report.media.linked).toBe(3);
    expect(readFileSync(join(dir, 'media', 'photos', 'inline.png'), 'utf8')).toBe('png-bytes');
    const store = openTree(dir);
    expect(value(store, 'SELECT format FROM import_batch')).toBe('gedzip');
    store.close();
  });

  it('detects a GEDZIP by content when given bytes or a path', async () => {
    const zip = zipSync({ 'gedcom.ged': sample() });
    const file = join(tmp, 'export.zip');
    writeFileSync(file, zip);
    const a = await importGedcom({ path: file }, openMemoryTree(), { today: TODAY });
    const b = await importGedcom({ bytes: zip }, openMemoryTree(), { today: TODAY });
    expect(a.format).toBe('gedzip');
    expect(b.records.INDI).toBe(26);
  });

  it('links files in an in-memory tree without copying them', async () => {
    const media = join(tmp, 'src');
    writeMedia(media);
    const { store, report } = await importInto(MEDIA_GED, { mediaDir: media });
    expect(report.media.linked).toBe(3);
    expect(value(store, "SELECT local_path FROM media WHERE external_id = '@O1@'")).toBe(
      'photos/portrait.JPG',
    );
  });

  it('does not follow symlinks out of the media folder and skips oversized files', async () => {
    const media = join(tmp, 'src');
    mkdirSync(join(media, 'photos'), { recursive: true });
    writeFileSync(join(tmp, 'secret.txt'), 'secret');
    symlinkSync(join(tmp, 'secret.txt'), join(media, 'photos', 'portrait.JPG'));
    writeFileSync(join(media, 'photos', 'inline.png'), 'x'.repeat(100));
    const dir = join(tmp, 's.oatree');
    const report = await importGedcom(
      { bytes: MEDIA_GED },
      { dir },
      { mediaDir: media, maxMediaBytes: 10 },
    );
    expect(existsSync(join(dir, 'media', 'photos', 'portrait.JPG'))).toBe(false);
    expect(existsSync(join(dir, 'media', 'photos', 'inline.png'))).toBe(false);
    expect(report.warnings.map((w) => w.code)).toContain('media-too-large');
    expect(report.media.linked).toBe(0);
  });

  it('reports local files as missing when no media source is given', async () => {
    const { report } = await importInto(MEDIA_GED);
    expect(report.media.missing.map((m) => m.path)).toEqual([
      'photos/inline.png',
      'photos/portrait.JPG',
      'C:\\Users\\someone\\Pictures\\letter.pdf',
      'photos/missing.jpg',
    ]);
    expect(report.media.linked).toBe(0);
  });

  it('keeps media metadata from Ancestry custom tags', async () => {
    const { store } = await importInto(
      ged(
        '0 @O1@ OBJE',
        '1 FILE https://example.com/a.tif',
        '2 FORM tif',
        '1 _WDTH 1200',
        '1 _HGHT 800',
        '1 _SIZE 1234',
        '1 _DSCR A scanned page',
        '1 _TYPE DOCUMENT',
        '1 NOTE Found in the attic',
        '1 SOUR @S1@',
        '0 @S1@ SOUR',
        '1 TITL Box',
      ),
    );
    expect(
      row(store, 'SELECT kind, mime, width, height, byte_size, description FROM media'),
    ).toEqual({
      kind: 'document',
      mime: 'image/tiff',
      width: 1200,
      height: 800,
      byte_size: 1234,
      description: 'A scanned page',
    });
    expect(value(store, "SELECT count(*) FROM note_link WHERE owner_type = 'media'")).toBe(1);
    expect(value(store, "SELECT count(*) FROM citation_link WHERE owner_type = 'media'")).toBe(1);
  });
});

describe('importFile (server adapter)', () => {
  it('imports a path into an open store and reports progress objects', async () => {
    const file = join(tmp, 'upload.ged');
    writeFileSync(file, sample());
    const progress: unknown[] = [];
    const store = openMemoryTree();
    const report = await importFile(file, store, { onProgress: (p) => progress.push(p) });
    expect(report.records.INDI).toBe(26);
    expect(progress.at(-1)).toEqual({ phase: 'done', done: 1, total: 1 });
    expect(await importFile(file, openMemoryTree()).then((r) => r.records.FAM)).toBe(10);
  });
});
