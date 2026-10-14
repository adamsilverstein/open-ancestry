import { openTree, treePaths } from '@open-ancestry/db';
import { importGedcom } from '@open-ancestry/import';
import { unzipSync, zipSync } from 'fflate';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { afterAll, describe, expect, it } from 'vitest';
import { GedzipTooLargeError, buildGedzipExport, planGedzipExport, streamGedzip } from './index';
import { TODAY, ged } from './test-helpers';

/*
 * Issue #198: the GEDZIP export read every media file into memory and
 * zipped synchronously. It now plans the archive (GEDCOM text and media
 * list, one consistent snapshot) and streams it, one file at a time.
 */

const root = mkdtempSync(join(tmpdir(), 'oa-gdz-stream-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
});
