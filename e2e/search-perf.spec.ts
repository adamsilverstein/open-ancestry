import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import { budget, perfOnly } from './budget';
import { expect, test } from './fixtures';
import { readSeed, type PerfTree } from './tree-view-fixtures';

/*
 * Palette search latency (design.md section 7, F7; issue #112): typing at
 * 60ms a key, from the last keystroke to the first frame that paints fresh
 * People results, p95 of 20 queries < 50ms on the seeded trees. The server
 * answers in a few ms, so this guards what the user sees: debounce, request
 * scheduling and rendering. Results are appended to perf-results/tree-view.md
 * (the CI perf job summary). Run with `npm run e2e:perf`.
 */

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium measures the budgets');
test.skip(perfOnly(), 'Run with npm run e2e:perf');
test.describe.configure({ mode: 'serial' });

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
const summary = join(import.meta.dirname, '..', 'perf-results', 'tree-view.md');

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};

/** Surnames and given + surname pairs from across the tree, so every query has results. */
async function queries(page: Page, tree: PerfTree): Promise<string[]> {
  const names: { given: string; surname: string }[] = [];
  for (let i = 0; i < 10; i++) {
    const offset = Math.floor((tree.people * i) / 10);
    const res = await page.request.get(
      `/api/trees/${encodeURIComponent(tree.tree)}/people?sort=surname&dir=asc&limit=20&offset=${offset}`,
    );
    const { items } = (await res.json()) as {
      items: { given: string | null; surname: string | null }[];
    };
    for (const p of items) {
      if (p.given && p.surname) names.push({ given: p.given, surname: p.surname });
    }
  }
  const surnames = [...new Set(names.map((n) => n.surname))].slice(0, 10);
  const pairs = names.filter((_, i) => i % 19 === 7).slice(0, 10);
  return [...surnames, ...pairs.map((n) => `${n.given.split(' ')[0]} ${n.surname}`)];
}

/** Records, every frame, when the palette first shows enabled People results after the last input. */
async function watch(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __search: { last: number; fresh: number } };
    w.__search = { last: 0, fresh: 0 };
    const input = document.querySelector('[role="dialog"] [cmdk-input]')!;
    input.addEventListener('input', () => {
      w.__search.last = performance.now();
      w.__search.fresh = 0;
    });
    const people = () =>
      [...document.querySelectorAll('[role="dialog"] [cmdk-group]')].find(
        (g) => g.querySelector('[cmdk-group-heading]')?.textContent === 'People',
      );
    const tick = (now: number) => {
      const s = w.__search;
      if (
        s.last &&
        !s.fresh &&
        people()?.querySelector('[cmdk-item]:not([aria-disabled="true"])')
      ) {
        s.fresh = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const seed = readSeed();
const trees: PerfTree[] = [seed.perf, ...(seed.perf100k ? [seed.perf100k] : [])];

for (const tree of trees) {
  const people = tree.people.toLocaleString('en-US');
  test(
    `palette results within 50ms of the last key, ${people} people`,
    { tag: '@perf' },
    async ({ page }) => {
      test.setTimeout(120_000);
      await page.addInitScript((name) => localStorage.setItem('oa-tree', name), tree.tree);
      await page.goto('/people');
      await expect(page.locator('html[data-shell-ready]')).toBeAttached();
      const list = await queries(page, tree);
      expect(list.length).toBeGreaterThanOrEqual(15);

      await page.keyboard.press(`${modKey}+k`);
      const dialog = page.getByRole('dialog', { name: 'Command palette' });
      const input = dialog.getByRole('combobox');
      await expect(input).toBeFocused();
      await watch(page);

      const times: number[] = [];
      for (const q of list) {
        await input.fill('');
        await page.keyboard.type(q, { delay: 60 });
        await page.waitForFunction(
          () => (window as unknown as { __search: { fresh: number } }).__search.fresh > 0,
        );
        const t = await page.evaluate(() => {
          const s = (window as unknown as { __search: { last: number; fresh: number } }).__search;
          return s.fresh - s.last;
        });
        times.push(t);
        await expect(input).toHaveValue(q);
      }
      const p50 = percentile(times, 0.5);
      const p95 = percentile(times, 0.95);
      const limit = budget(50);
      mkdirSync(dirname(summary), { recursive: true });
      appendFileSync(
        summary,
        `| ${people} | Palette search, last key to fresh results | p50 ${p50.toFixed(0)}ms, p95 ${p95.toFixed(0)}ms | p95 < ${limit}ms | ${p95 < limit ? 'ok' : 'OVER'} |\n`,
      );
      console.log(`[${people}] palette search: p50 ${p50.toFixed(0)}ms p95 ${p95.toFixed(0)}ms`);
      expect(p95, `p95 of ${times.map((t) => t.toFixed(0)).join(', ')}`).toBeLessThan(limit);
    },
  );
}
