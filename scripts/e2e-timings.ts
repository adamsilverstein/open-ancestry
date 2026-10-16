/**
 * Prints the slowest e2e spec files from a Playwright JSON report as a
 * markdown table, for CI's job summary (#261): total time per file across
 * browsers and retries, so slow specs are visible without the HTML report.
 *
 * Usage: tsx scripts/e2e-timings.ts test-results/e2e-results.json [count]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

interface Result {
  duration: number;
  retry: number;
  status?: string;
}
interface Test {
  /** `skipped` for a test.skip(); `passed` for a test that should run. */
  expectedStatus?: string;
  results: Result[];
}
interface Spec {
  file: string;
  tests: Test[];
}
interface Report {
  suites: Suite[];
  errors?: { message?: string }[];
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
export function timingsByFile(report: Report): FileTiming[] {
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

/**
 * Tests that should have run but didn't, because the run stopped early at
 * `maxFailures`: Playwright reports them as skipped although they were never
 * marked skip. (Only a test that still fails after its retry counts toward
 * maxFailures, so a flaky test that passes on retry never stops a run.)
 */
export function notRunCount(report: Report): number {
  let count = 0;
  const visit = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests as Test[]) {
        const ran = test.results.some((r) => r.status !== 'skipped');
        if (!ran && test.expectedStatus !== 'skipped') count++;
      }
    }
    suite.suites?.forEach(visit);
  };
  report.suites.forEach(visit);
  return count;
}

/** The "stopped early" error Playwright adds when maxFailures is reached, if any. */
export function stoppedEarly(report: Report): string | undefined {
  return report.errors
    ?.map((e) => (e.message ? stripVTControlCharacters(e.message) : undefined))
    .find((m) => m?.includes('stopped early'));
}

export function timingsTable(timings: FileTiming[], count = 10, notRun = 0): string {
  const rows = timings
    .slice(0, count)
    .map((t) => `| ${t.file} | ${(t.ms / 1000).toFixed(1)} s | ${t.tests} | ${t.retries} |`);
  return [
    '### Slowest e2e spec files',
    '',
    ...(notRun > 0
      ? [
          `**${notRun} test${notRun === 1 ? '' : 's'} not run**: this shard stopped early at its failure limit.`,
          '',
        ]
      : []),
    'Worker time per file, summed over browsers and retries.',
    '',
    '| Spec | Time | Tests | Retries |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [path, count] = process.argv.slice(2);
  if (!path) throw new Error('Usage: tsx scripts/e2e-timings.ts <report.json> [count]');
  const report = JSON.parse(readFileSync(path, 'utf8')) as Report;
  const notRun = stoppedEarly(report) ? notRunCount(report) : 0;
  console.log(timingsTable(timingsByFile(report), Number(count) || 10, notRun));
}
