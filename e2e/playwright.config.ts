import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 4319);
const baseURL = `http://127.0.0.1:${port}`;
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: [
    [ci ? 'github' : 'list'],
    ['html', { outputFolder: '../playwright-report', open: 'never' }],
  ],
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
    command: `node ../apps/cli/dist/cli.js serve --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
