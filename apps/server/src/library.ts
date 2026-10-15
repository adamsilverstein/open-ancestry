import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  TREE_EXTENSION,
  createTree,
  meta,
  openTree,
  treePaths,
  type TreeStore,
} from '@open-ancestry/db';
import { ApiError, conflict, notFound } from './errors';

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
  if (name.length === 0) return 'Tree name is empty';
  if (name.length > MAX_TREE_NAME_LENGTH)
    return `Tree name is longer than ${MAX_TREE_NAME_LENGTH} characters`;
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
    .slice(0, MAX_TREE_NAME_LENGTH - 10)
    .trim();
  return !name || WINDOWS_DEVICE.test(name) ? `Imported ${name}`.trim() : name;
}

function assertTreeName(name: string): void {
  const problem = treeNameProblem(name);
  if (problem) throw new ApiError(400, 'bad_request', problem);
}

export interface TreeInfo {
  id: string;
  name: string;
  modifiedAt: string;
}

/**
 * A tree's name lives inside its folder, so a folder copied by hand (a backup,
 * an experiment) lists under the same name as the original. When names
 * repeat, every tree but the one whose folder matches the name (else the
 * first by folder) shows its folder name too: "Smith (Smith copy)".
 */
function distinctNames(trees: TreeInfo[]): TreeInfo[] {
  const byName = new Map<string, TreeInfo[]>();
  for (const tree of trees) byName.set(tree.name, [...(byName.get(tree.name) ?? []), tree]);
  return trees.map((tree) => {
    const same = byName.get(tree.name)!;
    if (same.length === 1) return tree;
    const keeper =
      same.find((t) => t.id === t.name) ?? [...same].sort((a, b) => a.id.localeCompare(b.id))[0];
    return tree === keeper ? tree : { ...tree, name: `${tree.name} (${tree.id})` };
  });
}

export class Library {
  readonly root: string;
  private readonly stores = new Map<string, TreeStore>();
  /** Trees that must not be renamed or deleted right now (e.g. importing). */
  /** Trees with an import queued or running, and how many. */
  private readonly busy = new Map<string, number>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true });
  }

  dirOf(id: string): string {
    assertTreeName(id);
    return join(this.root, `${id}${TREE_EXTENSION}`);
  }

  exists(id: string): boolean {
    return treeNameProblem(id) === null && existsSync(treePaths(this.dirOf(id)).database);
  }

  list(): TreeInfo[] {
    this.ensureRoot();
    const trees = readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith(TREE_EXTENSION) && !d.name.startsWith('.'))
      .map((d) => d.name.slice(0, -TREE_EXTENSION.length))
      .filter((id) => this.exists(id))
      .map((id) => this.info(id));
    return distinctNames(trees).sort((a, b) => a.name.localeCompare(b.name));
  }

  info(id: string): TreeInfo {
    return {
      id,
      name: meta.get(this.open(id), 'tree_name') || id,
      modifiedAt: statSync(treePaths(this.dirOf(id)).database).mtime.toISOString(),
    };
  }

  create(name: string): TreeStore {
    assertTreeName(name);
    this.ensureRoot();
    if (existsSync(this.dirOf(name))) throw conflict(`A tree named "${name}" already exists`);
    const store = createTree(this.dirOf(name), { name });
    this.stores.set(name, store);
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
      if (!marker || this.busy.has(id) || now - created < minAgeMs) continue;
      if (this.discardFailedImport(id, marker)) removed.push(id);
    }
    return removed;
  }

  private isPendingImport(id: string, marker: string): boolean {
    const store = this.open(id);
    if (meta.get(store, IMPORT_PENDING_KEY) !== marker) return false;
    const { n } = store.stmt('SELECT count(*) AS n FROM person').get() as { n: number };
    return n === 0;
  }

  /** The open store for a tree, opening (and caching) it on first use. */
  open(id: string): TreeStore {
    const cached = this.stores.get(id);
    if (cached) return cached;
    assertTreeName(id);
    if (!this.exists(id)) throw notFound(`Tree "${id}" not found`);
    const store = openTree(this.dirOf(id));
    this.stores.set(id, store);
    return store;
  }

  rename(id: string, name: string): void {
    assertTreeName(id);
    assertTreeName(name);
    if (!this.exists(id)) throw notFound(`Tree "${id}" not found`);
    if (name === id) return;
    if (existsSync(this.dirOf(name))) throw conflict(`A tree named "${name}" already exists`);
    this.assertIdle(id);
    this.close(id);
    renameSync(this.dirOf(id), this.dirOf(name));
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
    mkdirSync(trash, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(':', '-');
    renameSync(this.dirOf(id), join(trash, `${id} ${stamp}${TREE_EXTENSION}`));
  }

  /**
   * Marks a tree busy (an import is queued or running) until the returned
   * release is called: every write to it, rename and delete are refused.
   */
  markBusy(id: string): () => void {
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.busy.get(id) ?? 1) - 1;
      if (left > 0) this.busy.set(id, left);
      else this.busy.delete(id);
    };
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
    return this.busy.has(id);
  }

  /** Throws 409 while the tree is importing. */
  assertIdle(id: string): void {
    if (this.busy.has(id)) throw conflict(`Tree "${id}" is busy (an import is running)`);
  }

  private close(id: string): void {
    this.stores.get(id)?.close();
    this.stores.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.stores.keys()]) this.close(id);
  }
}
