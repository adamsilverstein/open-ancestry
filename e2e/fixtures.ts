import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

const rawCoverageDir = join(import.meta.dirname, '..', 'coverage', 'e2e', 'raw');

/**
 * Playwright `test` with an automatic fixture that saves the instrumented
 * build's `window.__coverage__` after each test when E2E_COVERAGE=1.
 */
export const test = base.extend<{ collectCoverage: void }>({
  collectCoverage: [
    async ({ page }, use) => {
      await use();
      if (process.env.E2E_COVERAGE !== '1') return;
      const coverage = await page
        .evaluate(() => (globalThis as unknown as { __coverage__?: unknown }).__coverage__)
        .catch(() => undefined);
      if (!coverage) return;
      await mkdir(rawCoverageDir, { recursive: true });
      await writeFile(join(rawCoverageDir, `${randomUUID()}.json`), JSON.stringify(coverage));
    },
    { auto: true },
  ],
});
