import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { BenchCase } from '../types';
import { makeTempDir } from '../../fixtures/temp-dir';

// design.md section 7: server cold start to first API response < 300ms; issue
// #54 targets a 200ms median. Measured on the built CLI exactly as users start
// it: process spawn until /api/health answers.
const cli = join(import.meta.dirname, '..', '..', 'apps', 'cli', 'dist', 'cli.js');
const library = makeTempDir('oa-bench-cold-');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function coldStart() {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [cli, 'serve', '--port', String(port), '--library', library],
    {
      stdio: 'ignore',
    },
  );
  try {
    for (;;) {
      const ok = await fetch(`http://127.0.0.1:${port}/api/health`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) return;
      if (child.exitCode !== null) throw new Error(`CLI exited with ${child.exitCode}`);
      await new Promise((r) => setTimeout(r, 1));
    }
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
}

export default [
  {
    name: 'server: cold start, CLI spawn to first API response',
    setup: () => {
      if (!existsSync(cli)) throw new Error(`${cli} is missing; run npm run build first`);
    },
    fn: coldStart,
    budgetMs: 200,
    metric: 'p50',
    iterations: 15,
    time: 0,
    warmupIterations: 2,
  },
] satisfies BenchCase[];
