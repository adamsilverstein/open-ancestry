import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
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
  mkdirSync(paths.media, { recursive: true });
  mkdirSync(paths.thumbs, { recursive: true });
  const store = new TreeStore(new Database(paths.database), dir, options);
  setName(store, name ?? basename(dir, TREE_EXTENSION));
  return store;
}

/** Opens an existing tree folder, applying any pending migrations. */
export function openTree(dir: string, options: StoreOptions = {}): TreeStore {
  assertTreeDir(dir);
  const paths = treePaths(dir);
  if (!existsSync(paths.database)) throw new Error(`Tree not found at ${dir}`);
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
