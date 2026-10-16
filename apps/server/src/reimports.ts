import { randomUUID } from 'node:crypto';
import { closeReimport, type ReimportSession } from '@open-ancestry/import';
import type { ReimportFolders } from './reimport-folders';

/*
 * Re-import sessions: an updated export compared with a tree, held in memory
 * (with its parsed copy) until the user applies or discards the review.
 */

export interface StoredReimport {
  id: string;
  tree: string;
  fileName: string;
  createdAt: string;
  session: ReimportSession;
}

export class ReimportSessions {
  private readonly sessions = new Map<string, StoredReimport & { at: number }>();
  private readonly maxSessions: number;
  private readonly maxAgeMs: number;

  private readonly folders: ReimportFolders | undefined;
  /**
   * Expires reviews on a timer too, so an abandoned one frees its parsed tree
   * and spill folder (up to 1 GiB) without waiting for the next re-import
   * call. Unref'd: it never keeps the process alive.
   */
  readonly sweeping: ReturnType<typeof setInterval> | undefined;

  constructor({
    maxSessions = 4,
    maxAgeMs = 60 * 60 * 1000,
    sweepMs = Math.min(maxAgeMs, 5 * 60 * 1000),
    folders,
  }: {
    maxSessions?: number;
    maxAgeMs?: number;
    /** How often to look for expired reviews (default: every 5 minutes, or maxAgeMs). */
    sweepMs?: number;
    folders?: ReimportFolders;
  } = {}) {
    this.maxSessions = maxSessions;
    this.maxAgeMs = maxAgeMs;
    this.folders = folders;
    this.sweeping = setInterval(() => this.expire(), sweepMs);
    this.sweeping.unref();
  }

  /** Whether a review of `tree` is open: the tree must not be renamed or deleted under it. */
  hasTree(tree: string): boolean {
    this.expire();
    return [...this.sessions.values()].some((s) => s.tree === tree);
  }

  add(tree: string, fileName: string, session: ReimportSession): StoredReimport {
    this.expire();
    // Each holds a parsed tree in memory: keep only the few used most recently.
    while (this.sessions.size >= this.maxSessions) {
      this.remove([...this.sessions.keys()][0]!);
    }
    const stored = {
      id: randomUUID(),
      tree,
      fileName,
      createdAt: new Date().toISOString(),
      session,
      at: Date.now(),
    };
    this.sessions.set(stored.id, stored);
    return stored;
  }

  /** A review by id; using it keeps it alive, so one in use isn't dropped mid-review. */
  get(id: string): StoredReimport | undefined {
    this.expire();
    const stored = this.sessions.get(id);
    if (!stored) return undefined;
    stored.at = Date.now();
    // Least recently used first, so a full set drops the review left longest.
    this.sessions.delete(id);
    this.sessions.set(id, stored);
    return stored;
  }

  remove(id: string): void {
    const stored = this.sessions.get(id);
    if (!stored) return;
    this.sessions.delete(id);
    closeReimport(stored.session);
    // Its working folder and owner file go with it.
    this.folders?.release(stored.session.mediaDir);
    this.folders?.release(stored.session.incomingDir);
  }

  closeAll(): void {
    clearInterval(this.sweeping);
    for (const id of [...this.sessions.keys()]) this.remove(id);
  }

  private expire(now = Date.now()): void {
    for (const [id, stored] of this.sessions) {
      if (now - stored.at > this.maxAgeMs) this.remove(id);
    }
  }
}
