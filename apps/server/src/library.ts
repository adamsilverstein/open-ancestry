import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import {
  TREE_EXTENSION,
  TreeAccessError,
  createTree,
  ensurePrivateDir,
  meta,
  openTree,
  readTreeName,
  treePaths,
  type TreeStore,
} from '@open-ancestry/db';
import { ApiError, busy, conflict, notFound } from './errors';
import type { ReimportFolders } from './reimport-folders';

/*
 * The library is a folder of trees: `<root>/<name>.oatree/`. A tree's API id
 * is its folder name without the extension. Deleted trees move to
 * `<root>/.trash/` so a mistaken delete can be recovered by hand.
 */

export const TRASH_DIR = '.trash';
/**
 * meta key set on a tree the server created for one import upload. It holds
 * that import's random marker until the import succeeds; a tree that still has
 * it (and no people) after a failure or restart is the leftover of that
 * import, and only then may the server remove it.
 */
export const IMPORT_PENDING_KEY = 'import_pending';
export const MAX_TREE_NAME_LENGTH = 100;
/**
 * The same cap in UTF-8 bytes. Most Linux file systems allow 255 bytes per
 * name; the folder adds ".oatree", and the trash a timestamp (#275 P1).
 */
export const MAX_TREE_NAME_BYTES = 200;
/**
 * How long a server connection waits for another connection's write lock (an
 * import worker's) before SQLITE_BUSY, which the API answers with 409. Short,
 * since the wait blocks the event loop.
 */
export const LIBRARY_BUSY_TIMEOUT_MS = 50;
/** How long the list shows a locked tree by folder name before trying it again. */
const LOCKED_LIST_MS = 2000;

/** `~/OpenAncestry`, or OA_LIBRARY when set. */
export function defaultLibraryRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OA_LIBRARY || join(homedir(), 'OpenAncestry'));
}

// Path separators, Windows-reserved characters, control characters, and `%`
// (the API refuses encoded `%` in paths, so such a tree could not be addressed).
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[/\\:*?"<>|%\u0000-\u001f\u007f]/;
/** Windows device names, reserved with any extension and in any case. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Why `name` cannot be a tree folder name, or null when it can. */
export function treeNameProblem(name: string): string | null {
  if (name.trim().length === 0) return 'Enter a tree name';
  if (name.length > MAX_TREE_NAME_LENGTH)
    return `Tree name is longer than ${MAX_TREE_NAME_LENGTH} characters`;
  if (Buffer.byteLength(name) > MAX_TREE_NAME_BYTES)
    return 'Tree name is too long for a folder name';
  if (name !== name.trim()) return 'Tree name has leading or trailing spaces';
  if (name.startsWith('.')) return 'Tree name cannot start with a dot';
  if (name.endsWith('.')) return 'Tree name cannot end with a dot';
  if (FORBIDDEN.test(name)) return 'Tree name contains a path separator or reserved character';
  if (WINDOWS_DEVICE.test(name)) return 'Tree name is reserved on Windows';
  return null;
}

/**
 * A tree name from an uploaded file name: the base name with characters the
 * library refuses replaced, trimmed to leave room for a " 2" suffix.
 */
export function treeNameFromFile(fileName: string): string {
  const base = fileName
    .replaceAll('\\', '/')
    .split('/')
    .pop()!
    .replace(/\.[^.]*$/, '');
  const name = base
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|%\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim();
  const short = truncate(name, MAX_TREE_NAME_LENGTH - 10, MAX_TREE_NAME_BYTES - 10).trim();
  return !short || WINDOWS_DEVICE.test(short) ? `Imported ${short}`.trim() : short;
}

/** `text` cut to whole characters (code points) within both a character and a UTF-8 byte budget. */
function truncate(text: string, maxLength: number, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (out.length + char.length > maxLength || bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

function assertTreeName(name: string): void {
  const problem = treeNameProblem(name);
  if (problem) throw new ApiError(400, 'bad_request', problem);
}

/** A tree's lock file while an import or compare runs in some server (#275 P3). */
const BUSY_LOCK = 'busy.lock';
/** A lock from another machine is trusted this long, as its process cannot be checked. */
const STALE_LOCK_MS = 24 * 60 * 60 * 1000;

interface BusyLock {
  pid: number;
  host: string;
  owner: string;
  at: string;
}

/** Whether a process on this machine is still running. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether two paths name the same folder (one may be another spelling of the other). */
function sameFolder(a: string, b: string): boolean {
  try {
    const [x, y] = [statSync(a), statSync(b)];
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

export interface TreeInfo {
  id: string;
  /** The stored name (what Rename edits). */
  name: string;
  /** What the switcher and start page show: the name, plus the folder when names repeat. */
  label: string;
  modifiedAt: string;
}

/** Control and format characters (bidi overrides, zero-width marks) that could disguise a label. */
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}]/gu;

/**
 * A tree's name lives inside its folder, so a folder copied by hand (a backup,
 * an experiment) lists under the same name as the original. When names
 * repeat, only the tree whose folder is named exactly that keeps the plain
 * label; every other one shows its folder too: "Smith (Smith copy)". The rule
 * depends only on each tree's own folder, so labels never swap between trees.
 */
function withLabels(trees: TreeInfo[]): TreeInfo[] {
  const counts = new Map<string, number>();
  for (const tree of trees) counts.set(tree.name, (counts.get(tree.name) ?? 0) + 1);
  return trees.map((tree) => {
    if (counts.get(tree.name)! < 2 || tree.id === tree.name) return tree;
    const folder = tree.id.replace(HIDDEN_CHARS, '') || 'copy';
    return { ...tree, label: `${tree.name} (${folder})` };
  });
}

export class Library {
  readonly root: string;
  private readonly stores = new Map<string, TreeStore>();
  /** Trees that must not be renamed or deleted right now (e.g. importing). */
  /** Trees with an import queued or running, and how many. */
  private readonly busy = new Map<string, number>();
  /** Trees another process had locked when last listed, until when to skip them. */
  private readonly lockedUntil = new Map<string, number>();

  /**
   * The re-import folders of the server using this library: opening a tree
   * sweeps the leftovers whose owner is gone (see reimport-folders.ts).
   */
  reimportFolders: ReimportFolders | undefined;

  /** Trees may be opened from a folder other accounts can write to (--shared-library). */
  readonly shared: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly uid: number | undefined;

  constructor(
    root: string,
    {
      shared = false,
      platform = process.platform,
      uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
    }: {
      shared?: boolean;
      /** For tests: the platform and account id to check as. */
      platform?: NodeJS.Platform;
      uid?: number | undefined;
    } = {},
  ) {
    this.root = resolve(root);
    this.shared = shared;
    this.platform = platform;
    this.uid = uid;
  }

  private rootChecked = false;

  /**
   * The library folder, private to the owner. One the app creates is made
   * 0700, as is an existing one holding nothing but trees. Any other folder
   * (`--library ~`, a group-shared folder) keeps its mode, since tightening
   * it would lock others out of their own files: say so once instead.
   */
  ensureRoot(): void {
    if (!existsSync(this.root)) {
      ensurePrivateDir(this.root);
      this.rootChecked = true;
      return;
    }
    if (this.rootChecked) return this.assertRootSafe();
    this.rootChecked = true;
    if (this.platform === 'win32' || (statSync(this.root).mode & 0o077) === 0) {
      return this.assertRootSafe();
    }
    const ours = (name: string) =>
      name.endsWith(TREE_EXTENSION) || name === TRASH_DIR || name === '.DS_Store';
    const entries = readdirSync(this.root);
    if (entries.length > 0 && entries.every(ours)) {
      ensurePrivateDir(this.root);
      // Tightening skips a folder that is not ours, so check what it is now.
      this.assertRootSafe();
    } else {
      this.assertRootSafe();
      console.warn(
        `Warning: other accounts can see the library folder ${this.root}; ` +
          'its trees are private, but consider a folder only you can open.',
      );
    }
  }

  /**
   * Refuses a library folder other accounts can write to (issue #211): they
   * could swap a tree folder between the app's checks and SQLite opening the
   * database by path. --shared-library accepts the risk; on Windows these mode
   * bits mean nothing.
   */
  private assertRootSafe(): void {
    if (this.shared || this.platform === 'win32') return;
    let stat;
    try {
      stat = statSync(this.root);
    } catch {
      return; // Not there yet: ensureRoot creates it private.
    }
    // A folder that looks private but is someone else's (swapped in under a
    // parent others can write to) is no safer than a writable one.
    if (this.uid !== undefined && stat.uid !== this.uid) {
      throw new ApiError(
        403,
        'forbidden',
        `The library folder ${this.root} belongs to another account, so it could ` +
          'swap a tree while it is open. Use a folder of your own, or pass --shared-library ' +
          '(or set OA_SHARED_LIBRARY=1) if you trust that account.',
      );
    }
    const { mode } = stat;
    if ((mode & 0o022) === 0) return;
    throw new ApiError(
      403,
      'forbidden',
      `The library folder ${this.root} is one other accounts can change ` +
        `(mode ${(mode & 0o777).toString(8)}), so they could swap a tree while it is open. ` +
        'Use a folder only you can write to, or pass --shared-library ' +
        '(or set OA_SHARED_LIBRARY=1) if you trust everyone who can write to it.',
    );
  }

  /**
   * The folder name (without extension) on disk for tree `id`: the entry
   * spelled `id` up to Unicode normalization, or null when there is none.
   * Case is never folded, so on a case-insensitive file system `combo` is not
   * `Combo`; an NFD spelling of an id is the same tree, with the same
   * connection and busy state, rather than a second connection to one file.
   */
  private onDisk(id: string): string | null {
    const wanted = `${id.normalize('NFC')}${TREE_EXTENSION}`;
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch {
      return null;
    }
    const entry = entries.includes(wanted)
      ? wanted
      : entries.find((name) => name.normalize('NFC') === wanted);
    return entry ? entry.slice(0, -TREE_EXTENSION.length) : null;
  }

  /** The tree id as spelled on disk, or in NFC for a tree that does not exist yet. */
  canonical(id: string): string {
    return this.onDisk(id) ?? id.normalize('NFC');
  }

  dirOf(id: string): string {
    assertTreeName(id);
    return join(this.root, `${this.canonical(id)}${TREE_EXTENSION}`);
  }

  exists(id: string): boolean {
    if (treeNameProblem(id) !== null) return false;
    // Not existsSync on the id: that folds case on case-insensitive file systems.
    const canonical = this.onDisk(id);
    return (
      canonical !== null &&
      existsSync(treePaths(join(this.root, `${canonical}${TREE_EXTENSION}`)).database)
    );
  }

  list(): TreeInfo[] {
    this.ensureRoot();
    const now = Date.now();
    // Forget trees that were locked a while ago, including deleted or renamed ones.
    for (const [id, until] of this.lockedUntil) if (until <= now) this.lockedUntil.delete(id);
    const trees = readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith(TREE_EXTENSION) && !d.name.startsWith('.'))
      .map((d) => d.name.slice(0, -TREE_EXTENSION.length))
      .filter(
        (id) =>
          treeNameProblem(id) === null &&
          existsSync(treePaths(join(this.root, `${id}${TREE_EXTENSION}`)).database),
      )
      .map((id) => this.listedInfo(id, now));
    return withLabels(trees).sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * What the list shows for a tree. A tree not open yet is read through a
   * short-lived read-only connection rather than opened: opening runs any
   * pending upgrade, and waiting on another process's upgrade (up to 30 s)
   * would freeze every page. A tree that can't be read right now (another
   * process holds its lock, a crashed writer left it needing recovery, its file
   * is damaged) is listed under its folder name, so one tree never fails the
   * whole list; opening it reports the problem. A locked tree is skipped
   * briefly so each list does not wait on it again.
   */
  private listedInfo(id: string, now: number): TreeInfo {
    if (this.stores.has(id)) return this.info(id);
    const dir = this.dirOf(id);
    const modifiedAt = statSync(treePaths(dir).database).mtime.toISOString();
    const byFolder = { id, name: id, label: id, modifiedAt };
    if ((this.lockedUntil.get(id) ?? 0) > now) return byFolder;
    this.lockedUntil.delete(id);
    let name: string | undefined;
    try {
      name = readTreeName(dir, { busyTimeoutMs: LIBRARY_BUSY_TIMEOUT_MS });
    } catch (error) {
      // A planted link or another account's file is refused, as when opening.
      if (error instanceof TreeAccessError) throw new ApiError(403, 'forbidden', error.message);
      if ((error as { code?: string }).code?.startsWith('SQLITE_BUSY')) {
        this.lockedUntil.set(id, now + LOCKED_LIST_MS);
      }
      return byFolder;
    }
    const stored = name || id;
    return { id, name: stored, label: stored, modifiedAt };
  }

  info(id: string): TreeInfo {
    const name = meta.get(this.open(id), 'tree_name') || id;
    return {
      id,
      name,
      label: name,
      modifiedAt: statSync(treePaths(this.dirOf(id)).database).mtime.toISOString(),
    };
  }

  create(name: string): TreeStore {
    assertTreeName(name);
    this.ensureRoot();
    if (existsSync(this.dirOf(name))) throw conflict(`A tree named "${name}" already exists`);
    const store = createTree(this.dirOf(name), {
      name,
      busyTimeoutMs: LIBRARY_BUSY_TIMEOUT_MS,
    });
    this.stores.set(this.canonical(name), store);
    return store;
  }

  /**
   * Creates a tree for one import upload, named after the file (" 2", " 3", ...
   * when taken), and tags it with `marker` (see IMPORT_PENDING_KEY).
   */
  createForImport(fileName: string, marker: string): string {
    const base = treeNameFromFile(fileName);
    for (let n = 1; n <= 1000; n++) {
      const id = n === 1 ? base : `${base} ${n}`;
      if (existsSync(this.dirOf(id))) continue;
      const store = this.create(id);
      store.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run(IMPORT_PENDING_KEY, marker);
      return id;
    }
    throw conflict(`No free tree name for "${base}"`);
  }

  /** The import tagged `marker` succeeded: the tree is the user's now. */
  clearImportPending(id: string, marker: string): void {
    this.open(id)
      .db.prepare('DELETE FROM meta WHERE key = ? AND value = ?')
      .run(IMPORT_PENDING_KEY, marker);
  }

  /**
   * Removes a tree only if it is the one created for the import tagged
   * `marker` (same folder, marker still set) and it has no people. Anything
   * else, including a tree since re-created under the same name, is left alone.
   */
  discardFailedImport(id: string, marker: string): boolean {
    if (!this.exists(id) || !this.isPendingImport(id, marker)) return false;
    this.close(id);
    rmSync(this.dirOf(id), { recursive: true, force: true });
    return true;
  }

  /**
   * Startup: removes empty trees left by imports a crash or restart
   * interrupted. Only trees created over `minAgeMs` ago are touched, so an
   * import another server process is running on the same library is safe.
   */
  sweepInterruptedImports(minAgeMs = 60 * 60 * 1000, now = Date.now()): string[] {
    const removed: string[] = [];
    if (!existsSync(this.root)) return removed;
    for (const { id } of this.list()) {
      const marker = meta.get(this.open(id), IMPORT_PENDING_KEY);
      const created = statSync(this.dirOf(id)).birthtimeMs || statSync(this.dirOf(id)).mtimeMs;
      if (!marker || this.busy.has(id) || this.busyElsewhere(id) || now - created < minAgeMs)
        continue;
      if (this.discardFailedImport(id, marker)) removed.push(id);
    }
    return removed;
  }

  /**
   * At startup: removes the trees' re-import folders whose owner is gone,
   * by the same ownership rule as the sweep when a tree opens (see
   * reimport-folders.ts), so another live server's reviews are kept.
   */
  sweepReimportLeftovers(): string[] {
    if (!existsSync(this.root)) return [];
    const folders = this.reimportFolders;
    if (!folders) return [];
    return this.list().flatMap(({ id }) => folders.sweep(this.dirOf(id)));
  }

  private isPendingImport(id: string, marker: string): boolean {
    const store = this.open(id);
    if (meta.get(store, IMPORT_PENDING_KEY) !== marker) return false;
    const { n } = store.stmt('SELECT count(*) AS n FROM person').get() as { n: number };
    return n === 0;
  }

  /** The open store for a tree, opening (and caching) it on first use. */
  open(id: string): TreeStore {
    // Cache keys are on-disk spellings, so an exact hit needs no lookup.
    const cached = this.stores.get(id);
    if (cached) return cached;
    this.assertRootSafe();
    assertTreeName(id);
    if (!this.exists(id)) throw notFound(`Tree "${id}" not found`);
    const canonical = this.canonical(id);
    const existing = this.stores.get(canonical);
    if (existing) return existing;
    let store: TreeStore;
    try {
      store = openTree(this.dirOf(canonical), { busyTimeoutMs: LIBRARY_BUSY_TIMEOUT_MS });
    } catch (error) {
      // A planted link or another account's file: say why, not a bare 500.
      if (error instanceof TreeAccessError) throw new ApiError(403, 'forbidden', error.message);
      throw error;
    }
    // A crash can leave a re-import's working folders (up to 256 MiB of media)
    // behind. Swept once the tree folder has passed openTree's access checks.
    this.reimportFolders?.sweep(this.dirOf(canonical));
    this.stores.set(canonical, store);
    return store;
  }

  rename(id: string, name: string): void {
    assertTreeName(id);
    assertTreeName(name);
    if (!this.exists(id)) throw notFound(`Tree "${id}" not found`);
    if (name === id) return;
    const from = this.dirOf(id);
    const to = this.dirOf(name);
    // On a case-insensitive or normalizing file system (macOS, Windows), the
    // folder found for `name` can be this tree's own: a rename that changes
    // only case or Unicode form is not a conflict with itself (#275 M8).
    const own = existsSync(to) && sameFolder(from, to);
    if (existsSync(to) && !own) throw conflict(`A tree named "${name}" already exists`);
    if (own && name.normalize('NFC') === this.canonical(id).normalize('NFC')) return;
    this.assertIdle(id);
    this.close(id);
    if (own) {
      // Through a temporary name, so the file system records the new spelling.
      const temp = join(this.root, `.renaming-${randomUUID()}${TREE_EXTENSION}`);
      renameSync(from, temp);
      renameSync(temp, join(this.root, `${name.normalize('NFC')}${TREE_EXTENSION}`));
    } else {
      renameSync(from, to);
    }
    // Not an undoable edit: the folder rename is not in the change log either.
    this.open(name).db.prepare("UPDATE meta SET value = ? WHERE key = 'tree_name'").run(name);
  }

  /** Moves the tree folder to `.trash/`. */
  delete(id: string): void {
    assertTreeName(id);
    if (!this.exists(id)) throw notFound(`Tree "${id}" not found`);
    this.assertIdle(id);
    this.close(id);
    const trash = join(this.root, TRASH_DIR);
    ensurePrivateDir(trash);
    const stamp = new Date().toISOString().replaceAll(':', '-');
    renameSync(this.dirOf(id), join(trash, `${id} ${stamp}${TREE_EXTENSION}`));
  }

  /**
   * Marks a tree busy (an import is queued or running) until the returned
   * release is called: every write to it, rename and delete are refused.
   */
  markBusy(tree: string): () => void {
    const id = this.canonical(tree);
    const count = this.busy.get(id) ?? 0;
    this.busy.set(id, count + 1);
    // Other servers on this library see the busy state through a lock file.
    if (count === 0) this.writeLock(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.busy.get(id) ?? 1) - 1;
      if (left > 0) this.busy.set(id, left);
      else {
        this.busy.delete(id);
        this.removeLock(id);
      }
    };
  }

  /** This Library's mark in lock files, so it never mistakes its own lock for another server's. */
  private readonly owner = randomUUID();

  private lockPath(id: string): string {
    return join(this.root, `${id}${TREE_EXTENSION}`, BUSY_LOCK);
  }

  private writeLock(id: string): void {
    const lock: BusyLock = {
      pid: process.pid,
      host: hostname(),
      owner: this.owner,
      at: new Date().toISOString(),
    };
    try {
      writeFileSync(this.lockPath(id), JSON.stringify(lock), { mode: 0o600 });
    } catch {
      // No tree folder (yet): nothing for another server to find either.
    }
  }

  private removeLock(id: string): void {
    if (this.readLock(id)?.owner === this.owner) rmSync(this.lockPath(id), { force: true });
  }

  private readLock(id: string): BusyLock | null {
    try {
      return JSON.parse(readFileSync(this.lockPath(id), 'utf8')) as BusyLock;
    } catch {
      return null;
    }
  }

  /**
   * Whether another server holds the tree's lock file. A lock from a process on
   * this machine that has exited is stale and removed; one from another machine
   * (a library on a network share) counts until it is a day old.
   */
  private busyElsewhere(tree: string): boolean {
    const id = this.canonical(tree);
    if (!existsSync(this.lockPath(id))) return false;
    const lock = this.readLock(id);
    if (!lock || lock.owner === this.owner) return false;
    const alive =
      lock.host === hostname()
        ? processAlive(lock.pid)
        : Date.now() - Date.parse(lock.at) < STALE_LOCK_MS;
    if (!alive) rmSync(this.lockPath(id), { force: true });
    return alive;
  }

  /** Marks a tree busy for the duration of `fn`. */
  async whileBusy<R>(id: string, fn: () => Promise<R>): Promise<R> {
    const release = this.markBusy(id);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  isBusy(id: string): boolean {
    return this.busy.size > 0 && (this.busy.has(id) || this.busy.has(this.canonical(id)));
  }

  /** Throws 409 while the tree is importing. */
  assertIdle(id: string): void {
    if (this.isBusy(id)) throw busy(`Tree "${id}" is busy (an import is running)`);
    if (this.busyElsewhere(id)) {
      throw busy(
        `Tree "${id}" is busy in another Open Ancestry server using this library (an import is running)`,
      );
    }
  }

  private close(tree: string): void {
    const id = this.stores.has(tree) ? tree : this.canonical(tree);
    this.stores.get(id)?.close();
    this.stores.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.stores.keys()]) this.close(id);
  }
}
