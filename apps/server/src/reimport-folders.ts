import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/*
 * A re-import keeps working folders inside the tree's folder: a GEDZIP's
 * media waiting for review (`.reimport-media-<uuid>`) and, with the worker
 * compare, the export's own tree (`.reimport-export-<uuid>.oatree`). Several
 * servers may share a library (#156), so every folder has an owner: a
 * `<folder>.owner` file naming the server (a random id) and its process,
 * which the server re-touches as a heartbeat while it holds the folder.
 *
 * A sweep removes a folder only when its owner is gone: the owning process
 * has exited, its heartbeat stopped (the pid was reused), there is no owner
 * file, or this server made it and no longer uses it. How old the folder is
 * never decides, so a review kept open all day is never swept.
 */

export type ReimportFolderKind = 'media' | 'export';

const FOLDER =
  /^\.reimport-(media|export)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.oatree)?$/;

/** The heartbeat: how often owners are re-touched, and how stale counts as stopped. */
const HEARTBEAT_MS = 30_000;
const SILENT_MS = 5 * 60_000;

interface Owner {
  serverId: string;
  pid: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One server's re-import folders: creates them, keeps them alive, and sweeps leftovers. */
export class ReimportFolders {
  readonly serverId = randomUUID();
  private readonly owned = new Set<string>();
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor() {
    this.heartbeat = setInterval(() => {
      const now = new Date();
      for (const path of this.owned) {
        try {
          utimesSync(`${path}.owner`, now, now);
        } catch {
          // Released or removed meanwhile.
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /**
   * A new folder for a review's work in `treeDir`, owned by this server. A
   * media folder is created; an export's is left for the importer to create
   * (it must be a new tree folder), with only its owner file written.
   */
  create(treeDir: string, kind: ReimportFolderKind): string {
    const path = join(
      treeDir,
      `.reimport-${kind}-${randomUUID()}${kind === 'export' ? '.oatree' : ''}`,
    );
    const owner: Owner = { serverId: this.serverId, pid: process.pid };
    writeFileSync(`${path}.owner`, JSON.stringify(owner), { flag: 'wx' });
    if (kind === 'media') mkdirSync(path);
    this.owned.add(path);
    return path;
  }

  /** Removes a folder this server no longer needs, with its owner file. */
  release(path: string | null | undefined): void {
    if (!path) return;
    this.owned.delete(path);
    rmSync(path, { recursive: true, force: true });
    rmSync(`${path}.owner`, { force: true });
  }

  /** Stops holding a folder without removing it (tests; a leak). */
  forget(path: string): void {
    this.owned.delete(path);
  }

  /**
   * Removes `treeDir`'s re-import folders whose owner is gone (see above).
   * Only real folders matching the names exactly: a symlink is never followed
   * or removed. Returns what was removed.
   */
  sweep(treeDir: string, now = Date.now()): string[] {
    const removed: string[] = [];
    let names: string[];
    try {
      names = readdirSync(treeDir);
    } catch {
      return removed;
    }
    for (const name of names) {
      if (!FOLDER.test(name)) continue;
      const path = join(treeDir, name);
      try {
        if (!lstatSync(path).isDirectory() || this.owned.has(path)) continue;
        if (this.ownerLives(path, now)) continue;
        rmSync(path, { recursive: true, force: true });
        rmSync(`${path}.owner`, { force: true });
        removed.push(path);
      } catch {
        // Gone already, or not ours to remove.
      }
    }
    return removed;
  }

  private ownerLives(path: string, now: number): boolean {
    let owner: Owner;
    let touched: number;
    try {
      const stat = lstatSync(`${path}.owner`);
      if (!stat.isFile()) return false;
      touched = stat.mtimeMs;
      owner = JSON.parse(readFileSync(`${path}.owner`, 'utf8')) as Owner;
    } catch {
      return false;
    }
    // Ours but not in use: leaked by a failed or abandoned review.
    if (owner.serverId === this.serverId) return false;
    return alive(owner.pid) && now - touched < SILENT_MS;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const path of [...this.owned]) this.release(path);
  }
}
