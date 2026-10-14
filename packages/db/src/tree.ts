import Database from 'better-sqlite3';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { basename, join } from 'node:path';
import { TreeStore, type StoreOptions } from './store';

/*
 * A tree is a folder: `<name>.oatree/` holding tree.sqlite (WAL mode),
 * media/ (originals, referenced by media.local_path) and thumbs/ (derived).
 */

export const TREE_EXTENSION = '.oatree';

export interface TreePaths {
  root: string;
  database: string;
  media: string;
  thumbs: string;
}

export function treePaths(dir: string): TreePaths {
  return {
    root: dir,
    database: join(dir, 'tree.sqlite'),
    media: join(dir, 'media'),
    thumbs: join(dir, 'thumbs'),
  };
}

/*
 * Family data is private to the OS account that owns it: on a shared computer
 * other accounts must not read the library. Folders are 0700, the database
 * 0600 (SQLite gives its -wal and -shm files the database's mode).
 */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Creates a folder (and parents) private to the owner, tightening it if it exists. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  restrictMode(dir, PRIVATE_DIR_MODE);
}

/**
 * Sets a path's mode where the platform has POSIX modes. Best effort: a path
 * that is missing or owned by another account keeps its mode.
 */
export function restrictMode(path: string, mode: number): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, mode);
  } catch {
    // ENOENT or EPERM: nothing to tighten, or not ours to change.
  }
}

/** Tightens an existing tree's folders and database files to the owner. */
function restrictTree(paths: TreePaths): void {
  for (const dir of [paths.root, paths.media, paths.thumbs]) restrictMode(dir, PRIVATE_DIR_MODE);
  for (const file of [paths.database, `${paths.database}-wal`, `${paths.database}-shm`]) {
    restrictMode(file, PRIVATE_FILE_MODE);
  }
}

export interface CreateTreeOptions extends StoreOptions {
  /** Display name; defaults to the folder name without `.oatree`. */
  name?: string;
}

function assertTreeDir(dir: string): void {
  if (!dir.endsWith(TREE_EXTENSION))
    throw new Error(`Tree folders must end with ${TREE_EXTENSION}: ${dir}`);
}

function setName(store: TreeStore, name: string): void {
  store.db.prepare("INSERT INTO meta (key, value) VALUES ('tree_name', ?)").run(name);
  store.db.prepare("INSERT INTO meta (key, value) VALUES ('created_at', ?)").run(store.clock());
}

/** Creates a new, empty tree folder and returns it open. */
export function createTree(dir: string, { name, ...options }: CreateTreeOptions = {}): TreeStore {
  assertTreeDir(dir);
  const paths = treePaths(dir);
  if (existsSync(paths.database)) throw new Error(`A tree already exists at ${dir}`);
  ensurePrivateDir(dir);
  ensurePrivateDir(paths.media);
  ensurePrivateDir(paths.thumbs);
  // Created private before SQLite opens it, so its -wal and -shm follow.
  closeSync(openSync(paths.database, 'wx', PRIVATE_FILE_MODE));
  const store = new TreeStore(new Database(paths.database), dir, options);
  setName(store, name ?? basename(dir, TREE_EXTENSION));
  return store;
}

/** Opens an existing tree folder, applying any pending migrations. */
export function openTree(dir: string, options: StoreOptions = {}): TreeStore {
  assertTreeDir(dir);
  const paths = treePaths(dir);
  if (!existsSync(paths.database)) throw new Error(`Tree not found at ${dir}`);
  restrictTree(paths);
  const db = new Database(paths.database, { fileMustExist: true });
  try {
    return new TreeStore(db, dir, options);
  } catch (error) {
    db.close();
    throw error;
  }
}

/** An in-memory tree for tests and tools. */
export function openMemoryTree({ name, ...options }: CreateTreeOptions = {}): TreeStore {
  const store = new TreeStore(new Database(':memory:'), null, options);
  if (name !== undefined) setName(store, name);
  return store;
}
