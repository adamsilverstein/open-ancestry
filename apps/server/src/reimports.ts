import { randomUUID } from 'node:crypto';
import { closeReimport, type ReimportSession } from '@open-ancestry/import';
import { REVIEW_MAX_AGE_MS, touchFolder } from './reimport-folders';

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

  constructor({ maxSessions = 4, maxAgeMs = REVIEW_MAX_AGE_MS } = {}) {
    this.maxSessions = maxSessions;
    this.maxAgeMs = maxAgeMs;
  }

  add(tree: string, fileName: string, session: ReimportSession): StoredReimport {
    this.expire();
    // Each holds a parsed tree in memory: keep only the newest few.
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

  get(id: string): StoredReimport | undefined {
    this.expire();
    const stored = this.sessions.get(id);
    // Its working folder is in use: keep the crash-leftover sweeps away from it.
    if (stored) touchFolder(stored.session.mediaDir);
    return stored;
  }

  remove(id: string): void {
    const stored = this.sessions.get(id);
    if (!stored) return;
    this.sessions.delete(id);
    closeReimport(stored.session);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.remove(id);
  }

  private expire(now = Date.now()): void {
    for (const [id, stored] of this.sessions) {
      if (now - stored.at > this.maxAgeMs) this.remove(id);
    }
  }
}
