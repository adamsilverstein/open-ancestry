import { treePaths, type MediaRow, type TreeStore } from '@open-ancestry/db';
import { createHash } from 'node:crypto';
import { lstatSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { storeMediaFile, type MediaSource } from '../media';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The file columns a copied media row gets. */
export interface CopiedFile {
  local_path: string;
}

/**
 * Copies the export's media files into the tree for an applied re-import
 * (#75), with the importer's rules: `storeMediaFile` never overwrites (a
 * different file gets a `-2` suffix, identical bytes are reused) and keeps
 * every write inside media/. Files written are remembered so a failed apply
 * can remove them. An undone apply keeps them, as attaching media does, and a
 * crash between copying and committing can leave a file nothing references:
 * both are harmless, and the next import that brings the same bytes reuses it.
 */
export class MediaCopier {
  private readonly root: string | null;
  private readonly source: MediaSource;
  private readonly maxBytes: number;
  private readonly written: string[] = [];
  private readonly folders: string[] = [];
  /** Files copied ahead of the write transaction, by incoming media id. */
  private readonly prepared = new Map<string, CopiedFile | null>();
  private readonly used = new Set<string>();

  constructor(store: TreeStore, source: MediaSource, maxBytes: number) {
    this.root = store.dir ? treePaths(store.dir).media : null;
    this.source = source;
    this.maxBytes = maxBytes;
  }

  /**
   * Copies the file an incoming media row was linked to (its `local_path`
   * names the file in the export). Null when there is no file to copy, or it
   * cannot be copied safely; the row is then kept without a file.
   */
  copy(m: Pick<MediaRow, 'id' | 'local_path' | 'sha256'>): CopiedFile | null {
    // Files are copied before the transaction (see `prepare`): never while it holds the tree.
    const file = this.prepared.get(m.id) ?? null;
    if (file) this.used.add(file.local_path);
    return file;
  }

  /**
   * Copies, before the write transaction, the files of every incoming media
   * row an apply might add or fill, so a large copy doesn't hold the tree's
   * write lock. What the apply ends up not using is removed by `keepUsed`.
   */
  prepare(rows: Pick<MediaRow, 'id' | 'local_path' | 'sha256'>[]): void {
    for (const m of rows) if (!this.prepared.has(m.id)) this.prepared.set(m.id, this.store(m));
  }

  private store(m: Pick<MediaRow, 'local_path' | 'sha256'>): CopiedFile | null {
    if (!this.root || !m.local_path) return null;
    const file = this.source.find({ type: 'local', path: m.local_path });
    if (!file || file.size > this.maxBytes) return null;
    try {
      // A symlinked media/ would carry the write wherever it points (#207).
      if (lstatSync(this.root).isSymbolicLink()) return null;
      const bytes = file.read();
      if (m.sha256 && sha256(bytes) !== m.sha256) return null;
      const stored = storeMediaFile(this.root, m.local_path, bytes, sha256);
      if (stored.written) this.written.push(join(this.root, ...stored.path.split('/')));
      if (stored.folder) this.folders.push(stored.folder);
      return { local_path: stored.path };
    } catch {
      return null;
    }
  }

  /** After a committed apply: removes the files prepared but not used. */
  keepUsed(): void {
    const root = this.root;
    if (!root) return;
    const keep = new Set([...this.used].map((p) => join(root, ...p.split('/'))));
    for (const file of this.written) if (!keep.has(file)) rmSync(file, { force: true });
    for (const folder of [...this.folders].reverse()) {
      try {
        rmdirSync(folder);
      } catch {
        // Not empty: a used file lives there.
      }
    }
    this.written.length = 0;
    this.folders.length = 0;
  }

  /** Removes what `prepare` wrote: the apply that needed them did not commit. */
  discard(): void {
    for (const file of this.written) rmSync(file, { force: true });
    for (const folder of this.folders.reverse()) rmSync(folder, { recursive: true, force: true });
    this.written.length = 0;
    this.folders.length = 0;
  }
}
