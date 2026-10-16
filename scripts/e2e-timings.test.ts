import { describe, expect, it } from 'vitest';
import { timingsByFile, timingsTable } from './e2e-timings';

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
});
