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
import { hostname } from 'node:os';
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
 * on this machine has exited, its heartbeat stopped (a reused pid, or a
 * server on another machine sharing the library over a network), there is no
 * owner file, or this server made it and no longer uses it. A process id is
 * trusted only on the machine that wrote it. How old the folder is never
 * decides, so a review kept open all day is never swept, and right after this
 * server wakes from sleep nothing is removed by heartbeat: the owner may have
 * slept too.
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
  /** The machine the pid belongs to; missing in owner files that predate it. */
  host?: string;
}

/** Heartbeat failures in a row before they are reported. */
const REPORT_AFTER = 3;

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
  private readonly host = hostname();
  private readonly warn: (message: string) => void;
  /** When this server's heartbeat last ran: a long gap means it was asleep. */
  private lastTick = Date.now();
  private readonly failures = new Map<string, number>();

  constructor({ warn = (message: string) => console.warn(message) } = {}) {
    this.warn = warn;
    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** One heartbeat: re-touches this server's owner files (the interval calls it). */
  tick(now = Date.now()): void {
    this.lastTick = now;
    const at = new Date(now);
    for (const path of this.owned) {
      try {
        utimesSync(`${path}.owner`, at, at);
        this.failures.delete(path);
      } catch (error) {
        const count = (this.failures.get(path) ?? 0) + 1;
        this.failures.set(path, count);
        if (count === REPORT_AFTER) {
          this.warn(
            `Re-import heartbeat keeps failing for ${path}.owner (${(error as Error).message}); another server may sweep it`,
          );
        }
      }
    }
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
    const owner: Owner = { serverId: this.serverId, pid: process.pid, host: this.host };
    writeFileSync(`${path}.owner`, JSON.stringify(owner), { flag: 'wx' });
    if (kind === 'media') mkdirSync(path);
    this.owned.add(path);
    return path;
  }

  /** Removes a folder this server no longer needs, with its owner file. */
  release(path: string | null | undefined): void {
    if (!path) return;
    this.owned.delete(path);
    this.failures.delete(path);
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
      // An owner file whose folder was never made (a crash before the importer
      // made the export's tree) goes by the same rule.
      const orphan = name.endsWith('.owner') && FOLDER.test(name.slice(0, -'.owner'.length));
      if (!FOLDER.test(name) && !orphan) continue;
      const path = join(treeDir, orphan ? name.slice(0, -'.owner'.length) : name);
      try {
        if (this.owned.has(path)) continue;
        if (orphan) {
          if (lstatSync(path, { throwIfNoEntry: false })) continue;
        } else if (!lstatSync(path).isDirectory()) continue;
        if (this.ownerLives(path, now)) continue;
        if (!orphan) rmSync(path, { recursive: true, force: true });
        rmSync(`${path}.owner`, { force: true });
        if (!orphan) removed.push(path);
      } catch {
        // Gone already, or not ours to remove.
      }
    }
    return removed;
  }

  /**
   * Whether any re-import folder in `treeDir` is in use, by this server or
   * another live one: the tree must not be renamed or deleted under it.
   */
  inUse(treeDir: string, now = Date.now()): boolean {
    let names: string[];
    try {
      names = readdirSync(treeDir);
    } catch {
      return false;
    }
    return names.some((name) => {
      const base = name.endsWith('.owner') ? name.slice(0, -'.owner'.length) : name;
      if (!FOLDER.test(base)) return false;
      const path = join(treeDir, base);
      return this.owned.has(path) || this.ownerLives(path, now);
    });
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
    // A pid means something only on the machine that wrote it.
    if (owner.host === this.host && !alive(owner.pid)) return false;
    if (now - touched < SILENT_MS) return true;
    // Silent: but if this server has just woken, the owner may have slept too.
    return now - this.lastTick > 2 * HEARTBEAT_MS;
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.failures.clear();
    for (const path of [...this.owned]) this.release(path);
  }
}
