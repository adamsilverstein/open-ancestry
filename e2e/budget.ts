/**
 * Timing budgets in e2e (design.md section 7) are for an M-series laptop, like
 * `npm run bench`; OA_BENCH_FACTOR scales them for slower machines (CI sets
 * 2.5). Tests that assert one are tagged `@perf` and skip themselves unless
 * OA_PERF=1 (`npm run e2e:perf`, the CI perf job), like tree-perf.spec.ts:
 * timings mean nothing in the instrumented, parallel coverage run.
 */
const factor = Number(process.env.OA_BENCH_FACTOR ?? 1);
if (!(factor > 0)) throw new Error(`OA_BENCH_FACTOR must be a positive number`);

export const budget = (ms: number) => ms * factor;

/** Skips the current test outside `npm run e2e:perf` and in coverage builds. */
export const perfOnly = () => process.env.OA_PERF !== '1' || process.env.E2E_COVERAGE === '1';
