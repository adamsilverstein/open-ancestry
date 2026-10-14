// page.evaluate callbacks run in the browser, so e2e code needs DOM types.
/// <reference lib="dom" />
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base } from '@playwright/test';
import libCoverage, { type CoverageMapData } from 'istanbul-lib-coverage';
import libSourceMaps from 'istanbul-lib-source-maps';

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
      // The build is instrumented after the TS/JSX transform. Remap to source
      // positions now so nyc merges it with unit coverage statement for statement.
      const remapped = await libSourceMaps
        .createSourceMapStore()
        .transformCoverage(libCoverage.createCoverageMap(coverage as CoverageMapData));
      await mkdir(rawCoverageDir, { recursive: true });
      await writeFile(
        join(rawCoverageDir, `${randomUUID()}.json`),
        JSON.stringify(remapped.toJSON()),
      );
    },
    { auto: true },
  ],
});
