import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../../fixtures/temp-dir';
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
  tree = join(makeTempDir('oa-folders-'), 'T.oatree');
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
    owner(dead, { serverId: 'gone', pid: 999_999_999, host: hostname() });
    // A server whose process id was reused: alive pid, but its heartbeat stopped.
    const silent = join(tree, '.reimport-media-00000000-0000-4000-8000-000000000002');
    mkdirSync(silent);
    owner(silent, { serverId: 'silent', pid: process.pid, host: hostname() });
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

describe('re-import folder ownership across machines and sleep (#246 review)', () => {
  const MINUTE = 60_000;
  const stale = (path: string, minutesAgo: number, now = Date.now()) => {
    const at = (now - minutesAgo * MINUTE) / 1000;
    utimesSync(`${path}.owner`, at, at);
  };

  it('trusts a process id only on its own machine; elsewhere only the heartbeat counts', () => {
    // Another machine's server, alive by its heartbeat, whose pid means nothing here.
    const remote = join(tree, '.reimport-media-00000000-0000-4000-8000-000000000011');
    mkdirSync(remote);
    owner(remote, { serverId: 'remote', pid: 999_999_999, host: 'another-machine' });
    // Another machine's server whose heartbeat stopped.
    const gone = join(tree, '.reimport-media-00000000-0000-4000-8000-000000000012');
    mkdirSync(gone);
    owner(gone, { serverId: 'gone', pid: process.pid, host: 'another-machine' });
    stale(gone, 10);
    expect(folders.sweep(tree)).toEqual([gone]);
    expect(existsSync(remote)).toBe(true);
  });

  it('removes nothing by heartbeat right after this server wakes from sleep', () => {
    const now = Date.now();
    const quiet = join(tree, '.reimport-media-00000000-0000-4000-8000-000000000013');
    mkdirSync(quiet);
    owner(quiet, { serverId: 'quiet', pid: 1, host: 'another-machine' });
    stale(quiet, 10, now + 20 * MINUTE);
    // This server's own last heartbeat was long ago: it slept, and so may the owner have.
    folders.tick(now);
    expect(folders.sweep(tree, now + 20 * MINUTE)).toEqual([]);
    expect(existsSync(quiet)).toBe(true);
    // Once its own heartbeat has run again, a still-silent owner is gone.
    folders.tick(now + 20 * MINUTE);
    expect(folders.sweep(tree, now + 20 * MINUTE)).toEqual([quiet]);
  });

  it('sweeps an owner file whose folder was never made, by the same rule', () => {
    const orphan = join(tree, '.reimport-export-00000000-0000-4000-8000-000000000014.oatree');
    owner(orphan, { serverId: 'gone', pid: 999_999_999, host: hostname() });
    // A live server's export folder the importer hasn't made yet stays.
    const pending = new ReimportFolders().create(tree, 'export');
    folders.sweep(tree);
    expect(existsSync(`${orphan}.owner`)).toBe(false);
    expect(existsSync(`${pending}.owner`)).toBe(true);
  });

  it('says whether any re-import folder in a tree is still in use', () => {
    expect(folders.inUse(tree)).toBe(false);
    const other = new ReimportFolders();
    const theirs = other.create(tree, 'media');
    expect(folders.inUse(tree)).toBe(true);
    other.release(theirs);
    expect(folders.inUse(tree)).toBe(false);
    const mine = folders.create(tree, 'export');
    expect(folders.inUse(tree)).toBe(true);
    folders.release(mine);
    other.close();
  });

  it('reports a heartbeat that keeps failing, once', () => {
    const warnings: string[] = [];
    const noisy = new ReimportFolders({ warn: (message) => warnings.push(message) });
    const path = noisy.create(tree, 'media');
    rmSync(`${path}.owner`);
    rmSync(path, { recursive: true });
    for (let n = 0; n < 5; n++) noisy.tick();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/heartbeat/);
    noisy.close();
  });
});
