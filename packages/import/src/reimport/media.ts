import { treePaths, type MediaRow, type TreeStore } from '@open-ancestry/db';
import { createHash } from 'node:crypto';
import { lstatSync, rmSync } from 'node:fs';
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
 * can remove them; an undone apply keeps them, as attaching media does.
 */
export class MediaCopier {
  private readonly root: string | null;
  private readonly source: MediaSource;
  private readonly maxBytes: number;
  private readonly written: string[] = [];
  private readonly folders: string[] = [];

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
  copy(m: Pick<MediaRow, 'local_path' | 'sha256'>): CopiedFile | null {
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

  /** Removes what `copy` wrote: the apply that needed them did not commit. */
  discard(): void {
    for (const file of this.written) rmSync(file, { force: true });
    for (const folder of this.folders.reverse()) rmSync(folder, { recursive: true, force: true });
    this.written.length = 0;
    this.folders.length = 0;
  }
}
