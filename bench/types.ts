export type LatencyMetric = 'mean' | 'p50' | 'p75' | 'p99';

/** One benchmark. Suites in bench/suites/*.bench.ts default-export an array of these. */
export interface BenchCase {
  name: string;
  fn: () => unknown;
  /** Runs once before measuring; use it to build inputs so they are not timed. */
  setup?: () => unknown;
  /** Runs before every iteration, untimed; for inputs one run uses up. */
  beforeEach?: () => unknown;
  /** Fails `npm run bench` when `metric` latency exceeds this many milliseconds. */
  budgetMs: number;
  /** Defaults to p99. */
  metric?: LatencyMetric;
  /** Minimum iterations (default 10) and minimum run time in ms (default 500). */
  iterations?: number;
  time?: number;
  /** Untimed warmup runs (tinybench default 16); 0 disables warmup for slow cases. */
  warmupIterations?: number;
}
