import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Temp folders for tests and benches. Every folder made here is removed when
 * the Vitest file that made it finishes (and, as a backstop, when the process
 * exits), so tests clean up without remembering to. Use this instead of
 * mkdtemp; the lint config enforces it in tests.
 */

const made = new Set<string>();

/** A fresh folder in the OS temp dir, removed after the current test file. */
export function makeTempDir(prefix = 'oa-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  return dir;
}

/** Removes every folder makeTempDir made so far. */
export function removeTempDirs(): void {
  for (const dir of made) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    made.delete(dir);
  }
}

if (process.env.VITEST) {
  // At import time a test file is being collected, so this hook belongs to it.
  const { afterAll } = await import('vitest');
  afterAll(removeTempDirs);
}
process.once('exit', removeTempDirs);
