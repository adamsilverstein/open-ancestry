import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDirs } from './temp-dir';

/*
 * Test temp folders piled up (over 100 GB of oa-* folders on a dev machine):
 * makeTempDir registers each one, and they are removed when the test file
 * finishes, so new tests clean up without remembering to.
 */

describe('makeTempDir', () => {
  it('makes a fresh, prefixed folder in the OS temp dir', () => {
    const a = makeTempDir('oa-temp-test-');
    const b = makeTempDir('oa-temp-test-');
    expect(a).not.toBe(b);
    expect(dirname(a)).toBe(tmpdir());
    expect(basename(a)).toMatch(/^oa-temp-test-/);
    expect(existsSync(a)).toBe(true);
  });

  it('removeTempDirs deletes every folder made, contents included', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'file.txt'), 'x');
    removeTempDirs();
    expect(existsSync(dir)).toBe(false);
    // Idempotent: nothing left to remove.
    expect(() => removeTempDirs()).not.toThrow();
  });
});

describe('on Ctrl-C or SIGTERM', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'removes only its own folders on %s, then dies by that signal',
    (signal) => {
      const other = makeTempDir('oa-temp-test-other-');
      // A child that makes a folder, then is interrupted before any cleanup hook runs.
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `const { makeTempDir } = await import(${JSON.stringify(join(import.meta.dirname, 'temp-dir.ts'))});
           console.log(makeTempDir('oa-temp-test-child-'));
           process.kill(process.pid, '${signal}');
           await new Promise((r) => setTimeout(r, 5000));`,
        ],
        { encoding: 'utf8', env: { ...process.env, VITEST: '' } },
      );
      const made = child.stdout.trim();
      expect(made).toMatch(/oa-temp-test-child-/);
      expect(existsSync(made)).toBe(false);
      expect(child.signal).toBe(signal);
      // Folders this process (the parent) made are not touched.
      expect(existsSync(other)).toBe(true);
    },
    20_000,
  );
});
