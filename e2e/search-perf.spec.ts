import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import { budget, perfOnly } from './budget';
import { expect, test } from './fixtures';
import { readSeed, type PerfTree } from './tree-view-fixtures';

/*
 * Palette search latency (design.md section 7, F7; issue #112): typing at
 * 60ms a key, from the last keystroke to the first frame that paints fresh
 * People results, p90 of 40 name queries < 50ms on the 10k tree (p90, not
 * p95: of 40 samples, p95 is the second slowest, and one OS hiccup on a loaded
 * runner should not fail the job). The 100k tree (optional in #112) and place
 * queries (bound by server time on common places) are reported, not asserted.
 * The server answers name queries in a few ms, so this guards what the user
 * sees: request scheduling and rendering. The budget scales on CI, so
 * src/api/search.test.tsx pins the scheduling itself (no debounce). Results are appended to perf-results/tree-view.md
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

/** Names and places from across the tree, so every query has results. */
async function queries(page: Page, tree: PerfTree) {
  const names: { given: string; surname: string }[] = [];
  const places = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const offset = Math.floor((tree.people * i) / 20);
    const res = await page.request.get(
      `/api/trees/${encodeURIComponent(tree.tree)}/people?sort=surname&dir=asc&limit=20&offset=${offset}`,
    );
    const { items } = (await res.json()) as {
      items: {
        given: string | null;
        surname: string | null;
        birth: { place: string | null } | null;
      }[];
    };
    for (const p of items) {
      if (p.given && p.surname) names.push({ given: p.given, surname: p.surname });
      const town = p.birth?.place?.split(',')[0]?.trim();
      if (town) places.add(town);
    }
  }
  const surnames = [...new Set(names.map((n) => n.surname))].slice(0, 20);
  const step = Math.max(1, Math.floor(names.length / 20));
  const pairs = names.filter((_, i) => i % step === 3).slice(0, 40 - surnames.length);
  return {
    names: [...surnames, ...pairs.map((n) => `${n.given.split(' ')[0]} ${n.surname}`)],
    places: [...places].slice(0, 5),
  };
}

function report(people: string, measure: string, times: number[], limit?: number) {
  const p50 = percentile(times, 0.5);
  const p90 = percentile(times, 0.9);
  const ok = limit === undefined || p90 < limit;
  mkdirSync(dirname(summary), { recursive: true });
  appendFileSync(
    summary,
    `| ${people} | ${measure} (${times.length}) | p50 ${p50.toFixed(0)}ms, p90 ${p90.toFixed(0)}ms, max ${Math.max(...times).toFixed(0)}ms | ${limit === undefined ? 'report only' : `p90 < ${limit}ms`} | ${ok ? 'ok' : 'OVER'} |\n`,
  );
  console.log(`[${people}] ${measure}: p50 ${p50.toFixed(0)}ms p90 ${p90.toFixed(0)}ms`);
  return p90;
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
      const { names, places } = await queries(page, tree);
      expect(names.length).toBeGreaterThanOrEqual(30);

      await page.keyboard.press(`${modKey}+k`);
      const dialog = page.getByRole('dialog', { name: 'Command palette' });
      const input = dialog.getByRole('combobox');
      await expect(input).toBeFocused();
      await watch(page);

      const measure = async (list: string[]) => {
        const times: number[] = [];
        for (const q of list) {
          await input.fill('');
          await page.keyboard.type(q, { delay: 60 });
          await page.waitForFunction(
            () => (window as unknown as { __search: { fresh: number } }).__search.fresh > 0,
          );
          times.push(
            await page.evaluate(() => {
              const s = (window as unknown as { __search: { last: number; fresh: number } })
                .__search;
              return s.fresh - s.last;
            }),
          );
          await expect(input).toHaveValue(q);
        }
        return times;
      };

      const times = await measure(names);
      const asserted = tree === seed.perf;
      const limit = budget(50);
      const p90 = report(
        people,
        'Palette name search, last key to fresh results',
        times,
        asserted ? limit : undefined,
      );
      if (places.length) {
        report(people, 'Palette place search, last key to fresh results', await measure(places));
      }
      if (asserted) {
        expect(p90, `p90 of ${times.map((t) => t.toFixed(0)).join(', ')}`).toBeLessThan(limit);
      }
    },
  );
}
