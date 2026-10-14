export type LatencyMetric = 'mean' | 'p50' | 'p75' | 'p99';

/** One benchmark. Suites in bench/suites/*.bench.ts default-export an array of these. */
export interface BenchCase {
  name: string;
  fn: () => unknown;
  /** Runs once before measuring; use it to build inputs so they are not timed. */
  setup?: () => unknown;
  /** Fails `npm run bench` when `metric` latency exceeds this many milliseconds. */
  budgetMs: number;
  /** Defaults to p99. */
  metric?: LatencyMetric;
  /** Minimum iterations (default 10) and minimum run time in ms (default 500). */
  iterations?: number;
  time?: number;
}
