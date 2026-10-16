/**
 * Prints the slowest e2e spec files from a Playwright JSON report as a
 * markdown table, for CI's job summary (#261): total time per file across
 * browsers and retries, so slow specs are visible without the HTML report.
 *
 * Usage: tsx scripts/e2e-timings.ts test-results/e2e-results.json [count]
 */
import { readFileSync } from 'node:fs';

interface Result {
  duration: number;
  retry: number;
}
interface Spec {
  file: string;
  tests: { results: Result[] }[];
}
interface Suite {
  file?: string;
  specs?: Spec[];
  suites?: Suite[];
}

export interface FileTiming {
  file: string;
  ms: number;
  tests: number;
  retries: number;
}

/** Total duration, test count and retries per spec file, slowest first. */
export function timingsByFile(report: { suites: Suite[] }): FileTiming[] {
  const byFile = new Map<string, FileTiming>();
  const visit = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      const entry = byFile.get(spec.file) ?? { file: spec.file, ms: 0, tests: 0, retries: 0 };
      for (const test of spec.tests) {
        entry.tests++;
        for (const result of test.results) {
          entry.ms += result.duration;
          if (result.retry > 0) entry.retries++;
        }
      }
      byFile.set(spec.file, entry);
    }
    suite.suites?.forEach(visit);
  };
  report.suites.forEach(visit);
  return [...byFile.values()].sort((a, b) => b.ms - a.ms);
}

export function timingsTable(timings: FileTiming[], count = 10): string {
  const rows = timings
    .slice(0, count)
    .map((t) => `| ${t.file} | ${(t.ms / 1000).toFixed(1)} s | ${t.tests} | ${t.retries} |`);
  return [
    '### Slowest e2e spec files',
    '',
    'Worker time per file, summed over browsers and retries.',
    '',
    '| Spec | Time | Tests | Retries |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

if (import.meta.filename === process.argv[1]) {
  const [path, count] = process.argv.slice(2);
  if (!path) throw new Error('Usage: tsx scripts/e2e-timings.ts <report.json> [count]');
  const report = JSON.parse(readFileSync(path, 'utf8')) as { suites: Suite[] };
  console.log(timingsTable(timingsByFile(report), Number(count) || 10));
}
