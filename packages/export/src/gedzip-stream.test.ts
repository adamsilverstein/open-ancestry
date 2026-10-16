import { openTree, treePaths } from '@open-ancestry/db';
import { importGedcom } from '@open-ancestry/import';
import { unzipSync, zipSync } from 'fflate';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import { GedzipTooLargeError, buildGedzipExport, planGedzipExport, streamGedzip } from './index';
import { TODAY, ged } from './test-helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

/*
 * Issue #198: the GEDZIP export read every media file into memory and
 * zipped synchronously. It now plans the archive (GEDCOM text and media
 * list, one consistent snapshot) and streams it, one file at a time.
 */

const root = makeTempDir('oa-gdz-stream-');

const gedcom = ged(
  '0 @I1@ INDI',
  '1 NAME Odile /Fernsby/',
  '1 OBJE @O1@',
  '1 OBJE @O2@',
  '0 @O1@ OBJE',
  '1 FILE photos/portrait.jpg',
  '0 @O2@ OBJE',
  '1 FILE notes/letter.txt',
);

let n = 0;
async function tree() {
  const dir = join(root, `T${n++}.oatree`);
  const archive = zipSync({
    'gedcom.ged': new TextEncoder().encode(gedcom),
    'photos/portrait.jpg': new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]),
    'notes/letter.txt': new TextEncoder().encode('Dear Odile,\n'.repeat(100)),
  });
  await importGedcom({ gedzip: archive }, { dir }, { today: TODAY });
  return { dir, store: openTree(dir) };
}

describe('streamed GEDZIP export', () => {
  it('produces the same archive contents as the in-memory export', async () => {
    const { store } = await tree();
    const plan = planGedzipExport(store, { now: TODAY });
    const streamed = unzipSync(await buffer(streamGedzip(plan)));
    const inMemory = unzipSync(buildGedzipExport(store, { now: TODAY }).bytes);
    expect(Object.keys(streamed).sort()).toEqual(Object.keys(inMemory).sort());
    for (const [name, bytes] of Object.entries(inMemory)) expect(streamed[name]).toEqual(bytes);
    expect(plan.warnings).toEqual([]);
    store.close();
  });

  it('leaves out a file that changed after the snapshot, saying so in warnings.txt', async () => {
    const { store, dir } = await tree();
    const plan = planGedzipExport(store, { now: TODAY });
    writeFileSync(join(treePaths(dir).media, 'notes', 'letter.txt'), 'rewritten meanwhile');
    const files = unzipSync(await buffer(streamGedzip(plan)));
    expect(Object.keys(files).sort()).toEqual([
      'gedcom.ged',
      'photos/portrait.jpg',
      'warnings.txt',
    ]);
    expect(new TextDecoder().decode(files['warnings.txt'])).toContain('notes/letter.txt');
    store.close();
  });

  it('refuses an archive over the size it can write, before sending anything', async () => {
    const { store } = await tree();
    expect(() => planGedzipExport(store, { now: TODAY, maxArchiveBytes: 1000 })).toThrow(
      GedzipTooLargeError,
    );
    expect(() => planGedzipExport(store, { now: TODAY, maxArchiveBytes: 1000 })).toThrow(
      /over 1000 bytes/,
    );
    store.close();
  });

  it('closes the file it was reading when the reader goes away partway', async () => {
    const { store, dir } = await tree();
    truncateSync(join(treePaths(dir).media, 'photos', 'portrait.jpg'), 64 * 1024 * 1024);
    const openFds = () => readdirSync('/dev/fd').length;
    const before = openFds();
    const stream = streamGedzip(planGedzipExport(store, { now: TODAY }));
    // Read into the middle of the 64 MiB file, then hang up.
    let read = 0;
    for await (const chunk of stream) {
      read += (chunk as Uint8Array).byteLength;
      if (read > 4 * 1024 * 1024) break;
    }
    await finished(stream).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(openFds()).toBe(before);
    store.close();
  });

  it('keeps a media file named warnings.txt apart from the warnings entry', async () => {
    const { store, dir } = await tree();
    const media = treePaths(dir).media;
    writeFileSync(join(media, 'warnings.txt'), 'a media file');
    store.db
      .prepare(
        "UPDATE media SET local_path = 'warnings.txt' WHERE local_path = 'photos/portrait.jpg'",
      )
      .run();
    const plan = planGedzipExport(store, { now: TODAY });
    writeFileSync(join(media, 'notes', 'letter.txt'), 'rewritten meanwhile');
    const files = unzipSync(await buffer(streamGedzip(plan)));
    expect(new TextDecoder().decode(files['media/warnings.txt'])).toBe('a media file');
    expect(new TextDecoder().decode(files['warnings.txt'])).toContain('notes/letter.txt');
    store.close();
  });

  it('leaves out a file swapped for another of the same size and time', async () => {
    const { store, dir } = await tree();
    const path = join(treePaths(dir).media, 'notes', 'letter.txt');
    const plan = planGedzipExport(store, { now: TODAY });
    const before = statSync(path);
    const swap = `${path}.new`;
    writeFileSync(swap, 'X'.repeat(before.size));
    utimesSync(swap, before.atime, before.mtime);
    renameSync(swap, path);
    const files = unzipSync(await buffer(streamGedzip(plan)));
    expect(files['notes/letter.txt']).toBeUndefined();
    expect(new TextDecoder().decode(files['warnings.txt'])).toContain('notes/letter.txt');
    store.close();
  });

  it('leaves out a file hard-linked from elsewhere after the snapshot', async () => {
    const { store, dir } = await tree();
    const plan = planGedzipExport(store, { now: TODAY });
    // Same inode, size and time as planned; only the link count changed.
    linkSync(join(treePaths(dir).media, 'notes', 'letter.txt'), join(dir, 'letter-link.txt'));
    const files = unzipSync(await buffer(streamGedzip(plan)));
    expect(files['notes/letter.txt']).toBeUndefined();
    expect(new TextDecoder().decode(files['warnings.txt'])).toContain('notes/letter.txt');
    store.close();
  });

  it('leaves out a file whose folder became a symlink out of the tree after the snapshot', async () => {
    const { store, dir } = await tree();
    const plan = planGedzipExport(store, { now: TODAY });
    // The same file, moved out of the tree and reached through a symlinked folder.
    const outside = makeTempDir('oa-outside-');
    renameSync(join(treePaths(dir).media, 'notes'), join(outside, 'notes'));
    symlinkSync(join(outside, 'notes'), join(treePaths(dir).media, 'notes'));
    const files = unzipSync(await buffer(streamGedzip(plan)));
    expect(files['notes/letter.txt']).toBeUndefined();
    expect(new TextDecoder().decode(files['warnings.txt'])).toContain('notes/letter.txt');
    store.close();
  });

  it('leaves out every file once the media folder became a symlink after the snapshot', async () => {
    const { store, dir } = await tree();
    const plan = planGedzipExport(store, { now: TODAY });
    const media = treePaths(dir).media;
    const real = `${media}-real`;
    mkdirSync(real);
    renameSync(media, join(real, 'm'));
    symlinkSync(join(real, 'm'), media);
    const files = unzipSync(await buffer(streamGedzip(plan)));
    expect(Object.keys(files).sort()).toEqual(['gedcom.ged', 'warnings.txt']);
    store.close();
  });

  it('warns about a file rewritten in place, at the same length, while it streamed', async () => {
    const { store, dir } = await tree();
    const path = join(treePaths(dir).media, 'photos', 'portrait.jpg');
    truncateSync(path, 3 * 1024 * 1024);
    const plan = planGedzipExport(store, { now: TODAY });
    const chunks: Uint8Array[] = [];
    let rewritten = false;
    for await (const chunk of streamGedzip(plan)) {
      chunks.push(chunk as Uint8Array);
      const read = chunks.reduce((sum, c) => sum + c.byteLength, 0);
      if (!rewritten && read > 1024 * 1024) {
        // Same inode and length, new bytes and time: only a look after reading shows it.
        const fd = openSync(path, 'r+');
        writeSync(fd, randomBytes(1024), 0, 1024, 2 * 1024 * 1024);
        closeSync(fd);
        utimesSync(path, new Date(2000, 0, 1), new Date(2000, 0, 1));
        rewritten = true;
      }
    }
    expect(rewritten).toBe(true);
    const files = unzipSync(Buffer.concat(chunks));
    expect(new TextDecoder().decode(files['warnings.txt'])).toContain('photos/portrait.jpg');
    store.close();
  });

  it('never estimates less than it writes, for incompressible data and non-ASCII names', async () => {
    const { store, dir } = await tree();
    const media = treePaths(dir).media;
    writeFileSync(join(media, 'notes', 'letter.txt'), randomBytes(1024 * 1024));
    store.db
      .prepare(
        "UPDATE media SET local_path = 'notes/lettre d’Odile – été.txt' WHERE local_path = 'notes/letter.txt'",
      )
      .run();
    renameSync(
      join(media, 'notes', 'letter.txt'),
      join(media, 'notes', 'lettre d’Odile – été.txt'),
    );
    const plan = planGedzipExport(store, { now: TODAY });
    const bytes = await buffer(streamGedzip(plan));
    expect(plan.archiveBytes).toBeGreaterThanOrEqual(bytes.byteLength);
    store.close();
  });
});
