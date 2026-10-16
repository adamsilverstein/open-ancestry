import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { notRunCount, stoppedEarly, timingsByFile, timingsTable } from './e2e-timings';

const spec = (file: string, ...durations: number[][]) => ({
  file,
  tests: durations.map((results) => ({
    results: results.map((duration, retry) => ({ duration, retry })),
  })),
});

describe('e2e timings', () => {
  it('sums worker time per spec file across nested suites and retries, slowest first', () => {
    const report = {
      suites: [
        { file: 'a.spec.ts', specs: [spec('a.spec.ts', [1000], [2000])] },
        {
          file: 'b.spec.ts',
          suites: [{ specs: [spec('b.spec.ts', [30_000, 31_000])] }],
        },
      ],
    };
    const timings = timingsByFile(report);
    expect(timings).toEqual([
      { file: 'b.spec.ts', ms: 61_000, tests: 1, retries: 1 },
      { file: 'a.spec.ts', ms: 3000, tests: 2, retries: 0 },
    ]);
    expect(timingsTable(timings, 1)).toContain('| b.spec.ts | 61.0 s | 1 | 1 |');
    expect(timingsTable(timings, 1)).not.toContain('a.spec.ts');
  });

  it('reads a report shaped like Playwright 1.64 JSON output', () => {
    const report = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'playwright-report.json'), 'utf8'),
    );
    expect(timingsByFile(report)).toEqual([
      // A flaky test counts both attempts, and its retry.
      { file: 'editing.spec.ts', ms: 39_312, tests: 2, retries: 1 },
      { file: 'app.spec.ts', ms: 800, tests: 1, retries: 0 },
    ]);
  });

  it('counts tests a shard never ran after stopping at maxFailures', () => {
    const report = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'playwright-report.json'), 'utf8'),
    );
    expect(stoppedEarly(report)).toBeUndefined();
    expect(notRunCount(report)).toBe(0);

    const skipped = (expectedStatus: string) => ({
      expectedStatus,
      results: [{ duration: 0, retry: 0, status: 'skipped' }],
    });
    const stopped = {
      suites: [
        {
          file: 'x.spec.ts',
          specs: [{ file: 'x.spec.ts', tests: [skipped('passed'), skipped('passed')] }],
        },
        // A test.skip() is not "not run".
        { file: 'y.spec.ts', specs: [{ file: 'y.spec.ts', tests: [skipped('skipped')] }] },
      ],
      errors: [
        { message: '\u001b[31mTesting stopped early after 10 maximum allowed failures.\u001b[39m' },
      ],
    };
    expect(stoppedEarly(stopped)).toBe('Testing stopped early after 10 maximum allowed failures.');
    expect(notRunCount(stopped)).toBe(2);
    expect(timingsTable([], 10, 2)).toContain('**2 tests not run**');
    expect(timingsTable([], 10, 0)).not.toContain('not run');
  });
});
