/**
 * Benchmark runner. Discovers bench/suites/*.bench.ts, runs every case with
 * tinybench, prints a table and exits non-zero when any case is over budget.
 *
 * Usage: npm run bench [-- <name filter>]
 *
 * TODO: compare against a stored baseline and fail on >20% regressions
 * (design.md section 6) once real hot paths have suites.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Bench } from 'tinybench';
import type { BenchCase } from './types';

const suitesDir = join(import.meta.dirname, 'suites');
const filter = process.argv[2];

const cases: BenchCase[] = [];
for (const file of (await readdir(suitesDir)).filter((f) => f.endsWith('.bench.ts')).sort()) {
  const mod = (await import(pathToFileURL(join(suitesDir, file)).href)) as { default: BenchCase[] };
  cases.push(...mod.default.filter((c) => !filter || c.name.includes(filter)));
}

const rows = [];
let failed = false;
for (const c of cases) {
  await c.setup?.();
  const bench = new Bench({
    iterations: c.iterations ?? 10,
    time: c.time ?? 500,
    ...(c.warmupIterations !== undefined && {
      warmup: c.warmupIterations > 0,
      warmupIterations: c.warmupIterations,
    }),
  });
  bench.add(c.name, c.fn);
  await bench.run();
  const result = bench.tasks[0]?.result;
  if (!result || !('latency' in result)) {
    const error = result && 'error' in result ? result.error : 'no result';
    console.error(`${c.name}: ${String(error)}`);
    failed = true;
    continue;
  }
  const metric = c.metric ?? 'p99';
  const value = result.latency[metric];
  const ok = value <= c.budgetMs;
  failed ||= !ok;
  rows.push({
    name: c.name,
    'mean ms': result.latency.mean.toFixed(2),
    'p99 ms': result.latency.p99.toFixed(2),
    budget: `${metric} <= ${c.budgetMs}ms`,
    samples: result.latency.samplesCount,
    status: ok ? 'ok' : 'OVER BUDGET',
  });
}

console.table(rows);
if (failed) {
  console.error('One or more benchmarks failed or exceeded their budget.');
  process.exit(1);
}
