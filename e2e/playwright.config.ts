import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/** Asks the OS for a free loopback port so parallel worktrees never collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

// Workers re-load this config, so the port chosen by the runner is pinned in
// the environment they inherit.
process.env.E2E_PORT ??= String(await freePort());
const port = Number(process.env.E2E_PORT);
// A throwaway library per run, never the user's ~/OpenAncestry. global-setup.ts
// adds the fixture tree to it; workers find it through the environment.
if (!process.env.OA_E2E_LIBRARY) {
  process.env.OA_E2E_LIBRARY = join(tmpdir(), `oa-e2e-library-${port}`);
  // Ours to remove when the run ends (global-teardown.ts); a library passed in is kept.
  process.env.OA_E2E_LIBRARY_OWNER = String(process.pid);
}
const library = process.env.OA_E2E_LIBRARY;
const baseURL = `http://127.0.0.1:${port}`;
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  globalSetup: ['./global-setup.ts', './search-setup.ts'],
  globalTeardown: './global-teardown.ts',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: [
    [ci ? 'github' : 'list'],
    ['html', { outputFolder: '../playwright-report', open: 'never' }],
  ],
  // Visual baselines are Chromium on Linux only (see design.spec.ts), so the
  // path drops the default project and platform suffixes.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002 },
  },
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // The real built app, served by the CLI exactly as users run it.
  // `npm run e2e` builds first.
  webServer: {
    command: `node ../apps/cli/dist/cli.js serve --no-open --port ${port} --library "${library}"`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    // Workers share this server: room for every parallel test's re-import review,
    // so one isn't dropped (and Compare again answered 404) mid-test, and for
    // their imports to wait their turn rather than be turned away (429).
    env: { OA_MAX_REIMPORTS: '64', OA_MAX_QUEUED_IMPORTS: '64' },
  },
});
