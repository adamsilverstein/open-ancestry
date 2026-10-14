// page.evaluate callbacks run in the browser, so e2e code needs DOM types.
/// <reference lib="dom" />
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import { FIXTURE_TREE } from './tree-fixture';
import libCoverage, { type CoverageMapData } from 'istanbul-lib-coverage';
import libSourceMaps from 'istanbul-lib-source-maps';

export { expect };

const rawCoverageDir = join(import.meta.dirname, '..', 'coverage', 'e2e', 'raw');

/**
 * Playwright `test` with automatic fixtures: `cspGuard` fails a test that trips
 * the CSP, `currentTree` opens the fixture tree from global-setup.ts, and `collectCoverage` saves the instrumented
 * build's `window.__coverage__` after each test when E2E_COVERAGE=1.
 */
export const test = base.extend<{ collectCoverage: void; currentTree: void; cspGuard: void }>({
  // Issue #106: any Content Security Policy violation in any test fails it.
  cspGuard: [
    async ({ page }, use) => {
      await page.addInitScript(() => {
        const seen: string[] = [];
        (globalThis as unknown as { __cspViolations: string[] }).__cspViolations = seen;
        document.addEventListener('securitypolicyviolation', (event) => {
          seen.push(`${event.violatedDirective} at ${event.sourceFile}:${event.lineNumber}`);
        });
      });
      await use();
      const violations = await page
        .evaluate(() => (globalThis as unknown as { __cspViolations?: string[] }).__cspViolations)
        .catch(() => undefined);
      expect(violations ?? [], 'Content Security Policy violations').toEqual([]);
    },
    { auto: true },
  ],
  currentTree: [
    async ({ page }, use) => {
      // Other specs create trees in the same library; always open the fixture.
      await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), FIXTURE_TREE);
      await use();
    },
    { auto: true },
  ],
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
