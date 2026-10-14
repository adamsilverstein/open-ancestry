import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
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
export const MAX_TREE_NAME_LENGTH = 100;

/** `~/OpenAncestry`, or OA_LIBRARY when set. */
export function defaultLibraryRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OA_LIBRARY || join(homedir(), 'OpenAncestry'));
}

// Path separators, Windows-reserved characters and control characters.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f\u007f]/;

/** Why `name` cannot be a tree folder name, or null when it can. */
export function treeNameProblem(name: string): string | null {
  if (name.length === 0) return 'Tree name is empty';
  if (name.length > MAX_TREE_NAME_LENGTH)
    return `Tree name is longer than ${MAX_TREE_NAME_LENGTH} characters`;
  if (name !== name.trim()) return 'Tree name has leading or trailing spaces';
  if (name.startsWith('.')) return 'Tree name cannot start with a dot';
  if (name.endsWith('.')) return 'Tree name cannot end with a dot';
  if (FORBIDDEN.test(name)) return 'Tree name contains a path separator or reserved character';
  return null;
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

export class Library {
  readonly root: string;
  private readonly stores = new Map<string, TreeStore>();
  /** Trees that must not be renamed or deleted right now (e.g. importing). */
  private readonly busy = new Set<string>();

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
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith(TREE_EXTENSION) && !d.name.startsWith('.'))
      .map((d) => d.name.slice(0, -TREE_EXTENSION.length))
      .filter((id) => this.exists(id))
      .map((id) => this.info(id))
      .sort((a, b) => a.name.localeCompare(b.name));
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

  /** Marks a tree busy for the duration of `fn` (rename and delete are refused). */
  async whileBusy<R>(id: string, fn: () => Promise<R>): Promise<R> {
    this.busy.add(id);
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
    }
  }

  private assertIdle(id: string): void {
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
