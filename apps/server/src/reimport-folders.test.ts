import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReimportFolders } from './reimport-folders';

/*
 * #243/#246 review: a re-import's working folders belong to the server that
 * made them. A sweep removes only folders whose owner is gone (its process
 * exited, or it stopped its heartbeat), or that this server made and no
 * longer uses. Folder age alone never decides.
 */

let tree: string;
let folders: ReimportFolders;
beforeEach(() => {
  tree = join(mkdtempSync(join(tmpdir(), 'oa-folders-')), 'T.oatree');
  mkdirSync(tree);
  folders = new ReimportFolders();
});
afterEach(() => {
  folders.close();
  rmSync(join(tree, '..'), { recursive: true, force: true });
});

const owner = (path: string, value: object) =>
  writeFileSync(`${path}.owner`, JSON.stringify(value));

describe('re-import folder ownership', () => {
  it('creates distinctly named, owned folders and releases them', () => {
    const media = folders.create(tree, 'media');
    const exportDir = folders.create(tree, 'export');
    expect(media).toMatch(/\/\.reimport-media-[0-9a-f-]{36}$/);
    expect(exportDir).toMatch(/\/\.reimport-export-[0-9a-f-]{36}\.oatree$/);
    expect(existsSync(media)).toBe(true);
    // The export's folder is made by the importer; only its owner file exists yet.
    expect(existsSync(exportDir)).toBe(false);
    expect(existsSync(`${exportDir}.owner`)).toBe(true);
    folders.release(media);
    folders.release(exportDir);
    expect(readdirSync(tree)).toEqual([]);
  });

  it('keeps a folder in use, however old, and removes one this server leaked', () => {
    const live = folders.create(tree, 'media');
    const old = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
    utimesSync(live, old, old);
    const leaked = folders.create(tree, 'media');
    folders.forget(leaked);
    expect(folders.sweep(tree)).toEqual([leaked]);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(`${leaked}.owner`)).toBe(false);
  });

  it("keeps another live server's folders, and removes a dead or silent server's", () => {
    const other = new ReimportFolders();
    const theirs = other.create(tree, 'media');
    // A crashed server: its process is gone.
    const dead = join(tree, '.reimport-media-00000000-0000-4000-8000-000000000001');
    mkdirSync(dead);
    owner(dead, { serverId: 'gone', pid: 999_999_999 });
    // A server whose process id was reused: alive pid, but its heartbeat stopped.
    const silent = join(tree, '.reimport-media-00000000-0000-4000-8000-000000000002');
    mkdirSync(silent);
    owner(silent, { serverId: 'silent', pid: process.pid });
    const stale = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(`${silent}.owner`, stale, stale);
    // No owner file at all: a crash before it was written.
    const orphan = join(tree, '.reimport-media-00000000-0000-4000-8000-000000000003');
    mkdirSync(orphan);
    expect(folders.sweep(tree).sort()).toEqual([dead, silent, orphan].sort());
    expect(existsSync(theirs)).toBe(true);
    other.close();
  });

  it('touches nothing else: other names, files and symlinks', () => {
    const elsewhere = join(tree, '..', 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'keep.jpg'), 'x');
    symlinkSync(elsewhere, join(tree, '.reimport-media-00000000-0000-4000-8000-000000000004'));
    mkdirSync(join(tree, '.reimportant'));
    mkdirSync(join(tree, '.reimport-abc'));
    mkdirSync(join(tree, 'media'));
    expect(folders.sweep(tree)).toEqual([]);
    expect(existsSync(join(elsewhere, 'keep.jpg'))).toBe(true);
    expect(readdirSync(tree).sort()).toEqual(
      [
        '.reimport-abc',
        '.reimport-media-00000000-0000-4000-8000-000000000004',
        '.reimportant',
        'media',
      ].sort(),
    );
  });
});
