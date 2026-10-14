import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { readSeed, type PerfTree } from './tree-view-fixtures';

/*
 * Tree view performance budgets (design.md section 7), Chromium only, on the
 * seeded synthetic trees (10,000 people always; 100,000 with OA_PERF_100K=1,
 * generated from another seed and viewed at its densest person, so its checks
 * lay out more than the 10k ones and must):
 *
 * - First paint: opening the home person's family view, navigation to the
 *   first rendered layout, median of 5 cold loads < 1s (the LCP budget).
 * - Re-focus with cached data, from the key press to the painted frame (fetch,
 *   worker layout, render), median of 30 < 50ms with the p95 reported: at fit
 *   (~500+ people painted) and at 35-45% zoom (cards mounted as DOM), each warm
 *   (the keyboard rested on the card past the prefetch dwell, so its layout was
 *   prepared) and cold (Enter at once, as after Find).
 * - Pan and zoom with 2,000+ laid-out cards, at fit and with cards mounted:
 *   median frame at 58fps or better and under 5% of frames over 33ms. Long
 *   tasks and the longest frame are reported, not asserted: on a loaded machine
 *   OS scheduling alone produces them.
 * - Memory: after the first round of re-focuses and pans, each further round
 *   grows the JS heap by under 2MB (no growth per interaction).
 *
 * OA_BENCH_FACTOR scales the time budgets (and the allowed share of frames
 * over 33ms) for slower machines (CI sets it), as in `npm run bench`; the fps
 * and memory budgets do not scale. Results are appended to perf-results/tree-view.md, which
 * CI copies into the job summary. Run with `npm run e2e:perf`. Instrumented
 * coverage builds skip these: instrumentation distorts timings.
 */

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium measures the budgets');
// Opt-in (npm run e2e:perf and the CI perf job set OA_PERF=1): in a plain
// `npm run e2e`, parallel workers would skew the timings for everyone.
test.skip(process.env.OA_PERF !== '1', 'Run with npm run e2e:perf');
test.skip(process.env.E2E_COVERAGE === '1', 'Timings are not meaningful in a coverage build');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });

const factor = Number(process.env.OA_BENCH_FACTOR ?? 1);
const summary = join(import.meta.dirname, '..', 'perf-results', 'tree-view.md');

function report(tree: PerfTree, measure: string, result: string, budget: string, ok: boolean) {
  mkdirSync(dirname(summary), { recursive: true });
  const people = tree.people.toLocaleString('en-US');
  appendFileSync(
    summary,
    `| ${people} | ${measure} | ${result} | ${budget} | ${ok ? 'ok' : 'OVER'} |\n`,
  );
  console.log(`[${people}] ${measure}: ${result} (budget ${budget})`);
}

const canvas = (page: Page) => page.getByRole('application', { name: /^Family tree/ });

async function ready(page: Page) {
  await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
}

async function settled(page: Page) {
  await expect(page.getByTestId('tree-world')).not.toHaveAttribute('data-animating');
}

async function stats(page: Page) {
  const world = page.getByTestId('tree-world');
  return {
    laidOut: Number(await world.getAttribute('data-node-count')),
    /** Cards inside the viewport, painted or mounted. */
    visible: Number(await world.getAttribute('data-visible-count')),
    mounted: await canvas(page).locator('[data-key]').count(),
  };
}

async function refocusCount(page: Page) {
  return page.evaluate(() => performance.getEntriesByName('oa-tree-refocus', 'measure').length);
}

async function lastRefocus(page: Page) {
  return page.evaluate(
    () => performance.getEntriesByName('oa-tree-refocus', 'measure').at(-1)!.duration,
  );
}

async function scale(page: Page) {
  return Number(await page.getByTestId('tree-world').getAttribute('data-scale'));
}

/** Zooms out step by step to the lowest zoom that still mounts cards (35-45%). */
async function zoomToMountedCards(page: Page) {
  while ((await scale(page)) > 0.45) {
    await page.keyboard.press('-');
    await settled(page);
  }
  expect(await scale(page)).toBeGreaterThanOrEqual(0.35);
}

/** Results of the 10k checks, which the 100k ones must exceed in size. */
const sizes = new Map<string, number>();
function checkSize(measure: string, laidOut: number) {
  const tenK = sizes.get(measure);
  // The 100k checks run after the 10k ones and must lay out more.
  if (tenK === undefined) sizes.set(measure, laidOut);
  else expect(laidOut, `${measure}: laid out vs the 10k tree`).toBeGreaterThan(tenK);
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};

/** Used JS heap after a forced garbage collection, in MB. */
async function heapMB(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  await cdp.detach();
  return usedSize / 1024 / 1024;
}

async function recordFrames(page: Page, run: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__frames = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (now: number) => {
      w.__frames.push(now - last);
      last = now;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await run();
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__stop = true;
    return w.__frames.slice(2);
  });
  return {
    count: frames.length,
    median: percentile(frames, 0.5),
    p95: percentile(frames, 0.95),
    max: Math.max(...frames),
    over33: frames.filter((f) => f > 33).length / frames.length,
  };
}

/** One pointer move per frame across the canvas and back, then pinch out and in. */
async function panAndPinch(page: Page) {
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width - 200, box.y + 300);
  await page.mouse.down();
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(box.x + box.width - 200 - i * 12, box.y + 300 + (i % 10) * 4);
  }
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(box.x + box.width - 920 + i * 12, box.y + 340 - (i % 10) * 4);
  }
  await page.mouse.up();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 20);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -20);
  await page.keyboard.up('Control');
}

const seed = readSeed();
const trees = [seed.perf, ...(seed.perf100k ? [seed.perf100k] : [])];

for (const tree of trees) {
  const people = tree.people.toLocaleString('en-US');
  const url = (person: string, extra: string) =>
    `/tree/${person}?tree=${encodeURIComponent(tree.tree)}${extra}`;

  test.describe(`${people}-person tree`, () => {
    test('first paint', async ({ browser }) => {
      const times: number[] = [];
      // Fresh contexts: nothing cached, as on opening the app at the home person.
      for (let i = 0; i < 5; i++) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await page.goto(url(tree.focusId, ''));
        await ready(page);
        // The mark lands after the frame paints, just after the view stops being busy.
        const firstPaint = () =>
          page.evaluate(
            () => performance.getEntriesByName('oa-tree-first-paint', 'mark')[0]?.startTime ?? 0,
          );
        await expect.poll(firstPaint).toBeGreaterThan(0);
        times.push(await firstPaint());
        await context.close();
      }
      const median = percentile(times, 0.5);
      const budget = 1000 * factor;
      report(
        tree,
        'First paint (home person, family view; navigation to tree on screen), median of 5',
        `${median.toFixed(0)}ms`,
        `< ${budget}ms`,
        median < budget,
      );
      expect(median).toBeLessThan(budget);
    });

    for (const [zoom, warm] of [
      ['fit', true],
      ['mounted', true],
      ['fit', false],
      ['mounted', false],
    ] as const) {
      const title = `re-focus ${warm ? 'warm' : 'cold'} ${
        zoom === 'fit'
          ? 'with ~500+ people on screen (fit, painted)'
          : 'with cards mounted (35-45% zoom)'
      }`;
      test(title, async ({ page }) => {
        await page.goto(url(tree.wideId, '&down=7&up=1'));
        await ready(page);
        await canvas(page).locator(`[data-key="${tree.wideId}"]`).focus();
        if (zoom === 'fit') await page.keyboard.press('0');
        else await zoomToMountedCards(page);
        await settled(page);
        const { laidOut } = await stats(page);

        // Keyboard: down to a child, Enter to re-focus, up again, Enter again. The
        // first round trip loads both neighborhoods; then they are cached. The zoom
        // is kept across re-focuses.
        const visible: number[] = [];
        const mounted: number[] = [];
        const refocus = async (key: string) => {
          await page.keyboard.press(key);
          // Warm: rest on the card past the prefetch dwell, as a user reading it
          // would, so its layout is prepared. Cold: Enter at once, as after Find.
          if (warm) await page.waitForTimeout(300);
          const before = await refocusCount(page);
          await page.keyboard.press('Enter');
          await expect.poll(() => refocusCount(page)).toBeGreaterThan(before);
          await ready(page);
          await settled(page);
          const now = await stats(page);
          visible.push(now.visible);
          mounted.push(now.mounted);
          return lastRefocus(page);
        };
        // Uncached: the first visit to each fetches its neighborhood.
        const uncached = [await refocus('ArrowDown'), await refocus('ArrowUp')];

        visible.length = 0;
        mounted.length = 0;
        const durations: number[] = [];
        // 30 samples: a steady median, and a p95 that is not just the slowest one.
        for (let i = 0; i < 15; i++) {
          durations.push(await refocus('ArrowDown'));
          durations.push(await refocus('ArrowUp'));
        }
        const p95 = percentile(durations, 0.95);
        const median = percentile(durations, 0.5);
        const mean = (values: number[]) =>
          Math.round(values.reduce((a, b) => a + b, 0) / values.length);
        const budget = 50 * factor;
        report(
          tree,
          `Re-focus ${warm ? 'warm' : 'cold'}, cached, ${zoom === 'fit' ? 'fit' : `${Math.round((await scale(page)) * 100)}% zoom`} (${laidOut} laid out, ${mean(visible)} on screen, ${mean(mounted)} mounted), median of 30`,
          `${median.toFixed(1)}ms (p95 ${p95.toFixed(1)}ms; uncached ${uncached.map((d) => d.toFixed(0)).join(' and ')}ms)`,
          `median < ${budget}ms`,
          median < budget,
        );
        if (zoom === 'fit') {
          expect(mean(visible)).toBeGreaterThanOrEqual(500);
          checkSize(`refocus ${zoom} ${warm}`, laidOut);
        } else {
          // Cards are DOM here, not painted.
          expect(mean(mounted)).toBeGreaterThanOrEqual(20);
        }
        // The median is budgeted; the p95 is reported. On a busy laptop the
        // slowest few of 30 are OS scheduling as much as the app.
        expect(median).toBeLessThan(budget);
      });
    }

    for (const scenario of [
      {
        name: 'fit, every card on screen',
        prepare: async (page: Page) => page.keyboard.press('0'),
        minVisible: 2000,
      },
      {
        // Just above the canvas level of detail, so cards are mounted DOM. Arrow
        // down into the denser lower generations first.
        name: '35-45% zoom, cards mounted',
        prepare: async (page: Page) => {
          for (let i = 0; i < 6; i++) {
            await page.keyboard.press('ArrowDown');
            await settled(page);
          }
          await zoomToMountedCards(page);
        },
        minVisible: 25,
      },
    ]) {
      test(`pan and zoom with 2,000+ laid-out cards: ${scenario.name}`, async ({ page }) => {
        await page.goto(url(tree.wideId, '&down=8&up=1'));
        await ready(page);
        await canvas(page).locator(`[data-key="${tree.wideId}"]`).focus();
        await scenario.prepare(page);
        await settled(page);
        const before = await stats(page);
        expect(before.laidOut).toBeGreaterThanOrEqual(2000);
        expect(before.visible).toBeGreaterThanOrEqual(scenario.minVisible);

        if (scenario.minVisible >= 2000) checkSize('pan fit', before.laidOut);

        // Long tasks (over 50ms on the main thread) are the direct jank signal;
        // rAF deltas are quantized to whole frames.
        await page.evaluate(() => {
          const w = window as unknown as { __longTasks: number[] };
          w.__longTasks = [];
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) w.__longTasks.push(entry.duration);
          }).observe({ type: 'longtask' });
        });
        const frames = await recordFrames(page, () => panAndPinch(page));
        const longTasks = await page.evaluate(
          () => (window as unknown as { __longTasks: number[] }).__longTasks,
        );
        const fps = 1000 / frames.median;
        const maxOver = 0.05 * factor;
        const ok = fps >= 58 && frames.over33 < maxOver;
        report(
          tree,
          `Pan and pinch, ${scenario.name} (${before.laidOut} laid out, ${before.visible} on screen, ${before.mounted} mounted)`,
          `median ${fps.toFixed(0)}fps, p95 ${frames.p95.toFixed(1)}ms, ${(frames.over33 * 100).toFixed(1)}% over 33ms (${frames.count} frames), longest frame ${frames.max.toFixed(0)}ms, ${longTasks.length} long tasks${longTasks.length ? ` (max ${Math.max(...longTasks).toFixed(0)}ms)` : ''}`,
          `>= 58fps, < ${(maxOver * 100).toFixed(1)}% over 33ms`,
          ok,
        );
        expect(fps).toBeGreaterThanOrEqual(58);
        expect(frames.over33).toBeLessThan(maxOver);
      });
    }

    test('memory stays flat across repeated interactions', async ({ page }) => {
      await page.goto(url(tree.wideId, '&down=7&up=1'));
      await ready(page);
      await page.getByRole('button', { name: 'Fit to screen' }).click();
      await settled(page);
      await canvas(page).locator(`[data-key="${tree.wideId}"]`).focus();
      const round = async () => {
        for (const key of ['ArrowDown', 'ArrowUp', 'ArrowDown', 'ArrowUp']) {
          await page.keyboard.press(key);
          const before = await refocusCount(page);
          await page.keyboard.press('Enter');
          await expect.poll(() => refocusCount(page)).toBeGreaterThan(before);
          await ready(page);
          await settled(page);
        }
        await panAndPinch(page);
        await canvas(page).locator(`[data-key="${tree.wideId}"]`).focus();
      };
      // The first round fills caches (neighborhoods, layouts); later rounds
      // repeat it and must not keep growing.
      const heap = [await heapMB(page)];
      for (let i = 0; i < 3; i++) {
        await round();
        heap.push(await heapMB(page));
      }
      const growth = Math.max(heap[2]! - heap[1]!, heap[3]! - heap[2]!);
      report(
        tree,
        'JS heap after GC: loaded, then after each of three rounds of re-focuses and pans',
        `${heap.map((h) => h.toFixed(1)).join(' / ')}MB`,
        '< 2MB growth per round after the first',
        growth < 2,
      );
      expect(growth).toBeLessThan(2);
    });
  });
}
