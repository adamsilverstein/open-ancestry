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
