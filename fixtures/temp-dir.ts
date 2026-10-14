import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Temp folders for tests and benches. Every folder made here is removed when
 * the Vitest file that made it finishes (and, as a backstop, when the process
 * exits or is interrupted), so tests clean up without remembering to. Use this instead of
 * mkdtemp; the lint config enforces it in tests.
 */

// Shared per process: Vitest re-imports this module for every test file in a
// worker, and the process hooks below must be added only once.
const REGISTRY = Symbol.for('open-ancestry.temp-dirs');
const shared = globalThis as typeof globalThis & { [REGISTRY]?: Set<string> };
const firstLoad = shared[REGISTRY] === undefined;
const made = (shared[REGISTRY] ??= new Set<string>());

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
if (firstLoad) {
  process.once('exit', removeTempDirs);

  // Ctrl-C or a kill skips afterAll and 'exit': remove this process's folders
  // (never anyone else's), then let the signal end the process as it would have.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      removeTempDirs();
      process.kill(process.pid, signal);
    });
  }
}
