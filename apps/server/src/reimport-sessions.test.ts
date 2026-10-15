import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReimportSession } from '@open-ancestry/import';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ReimportSessions } from './reimports';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-sessions-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('keeps a review in use from looking like a crash leftover', () => {
  const mediaDir = join(root, '.reimport-Live12');
  mkdirSync(mediaDir);
  const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(mediaDir, old, old);
  const session = { incoming: { close() {} }, mediaDir } as unknown as ReimportSession;
  const sessions = new ReimportSessions();
  const { id } = sessions.add('Tree', 'x.ged', session);
  sessions.get(id);
  // The open-time sweep only removes folders untouched for the session lifetime.
  expect(Date.now() - statSync(mediaDir).mtimeMs).toBeLessThan(60_000);
  sessions.closeAll();
});
