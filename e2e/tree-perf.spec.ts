import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { readSeed } from './tree-fixtures';

/*
 * Tree view performance budgets (design.md section 7) on the seeded
 * 10,000-person synthetic tree:
 * - re-focus (data cached): fetch + layout in the worker + render < 50ms
 * - pan and zoom at 60fps with 2,000+ laid-out cards
 * Chromium only; timings come from the app's performance marks and rAF.
 */

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium measures the budgets');

const { perf } = readSeed();
const url = (person: string, extra: string) =>
  `/tree/${person}?tree=${encodeURIComponent(perf.tree)}${extra}`;
const canvas = (page: Page) => page.getByRole('application', { name: /^Family tree/ });

async function ready(page: Page) {
  await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
}

async function lastRefocus(page: Page) {
  return page.evaluate(() => {
    const entries = performance.getEntriesByName('oa-tree-refocus', 'measure');
    const last = entries.at(-1);
    return last ? { duration: last.duration, count: entries.length } : null;
  });
}

async function layoutStats(page: Page) {
  const world = page.getByTestId('tree-world');
  return {
    laidOut: Number(await world.getAttribute('data-node-count')),
    mounted: await canvas(page).locator('[data-key]').count(),
  };
}

test('re-focus with cached data takes under 50ms for ~500 laid-out people', async ({ page }) => {
  // The founder has six generations of descendants below: several hundred cards.
  const extra = '&down=6&up=1';
  await page.goto(url(perf.founderId, extra));
  await ready(page);
  const { laidOut } = await layoutStats(page);
  expect(laidOut).toBeGreaterThanOrEqual(400);

  // Visit a child, then go back and forth: both neighborhoods are now cached.
  const child = await canvas(page)
    .locator('[data-key][data-generation="1"]')
    .first()
    .getAttribute('data-key');
  expect(child).toBeTruthy();
  await page.goto(url(child!, extra));
  await ready(page);

  const durations: number[] = [];
  for (let i = 0; i < 6; i++) {
    const target = i % 2 === 0 ? perf.founderId : child!;
    const before = (await lastRefocus(page))?.count ?? 0;
    await canvas(page).locator(`[data-key="${target}"]`).first().dblclick();
    await expect.poll(async () => (await lastRefocus(page))?.count ?? 0).toBeGreaterThan(before);
    durations.push((await lastRefocus(page))!.duration);
  }
  durations.sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)]!;
  console.log(
    `re-focus (cached), ${laidOut} laid out: median ${median.toFixed(1)}ms, all ${durations.map((d) => d.toFixed(1)).join(', ')}`,
  );
  expect(median).toBeLessThan(50);
});

test('pans and zooms at 60fps with 2,000+ laid-out cards', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url(perf.founderId, '&down=8&up=1'));
  await ready(page);
  const { laidOut, mounted } = await layoutStats(page);
  expect(laidOut).toBeGreaterThanOrEqual(2000);
  // Virtualized: only what is on screen (plus overscan) is in the DOM.
  expect(mounted).toBeLessThan(laidOut / 4);

  const box = (await canvas(page).boundingBox())!;
  const startFrames = () =>
    page.evaluate(() => {
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
  const stopFrames = () =>
    page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean };
      w.__stop = true;
      return w.__frames.slice(2);
    });

  // Scripted pan: one pointer move per frame across the canvas, then back.
  await startFrames();
  await page.mouse.move(box.x + box.width - 200, box.y + 200);
  await page.mouse.down();
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(box.x + box.width - 200 - i * 15, box.y + 200 + (i % 10) * 5);
  }
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(box.x + box.width - 1100 + i * 15, box.y + 250 - (i % 10) * 5);
  }
  await page.mouse.up();
  // Zoom out and in with the wheel (pinch).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 40);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -40);
  await page.keyboard.up('Control');
  const frames = await stopFrames();

  frames.sort((a, b) => a - b);
  const mean = frames.reduce((s, f) => s + f, 0) / frames.length;
  const p95 = frames[Math.floor(frames.length * 0.95)]!;
  console.log(
    `pan/zoom, ${laidOut} laid out: ${frames.length} frames, mean ${mean.toFixed(1)}ms (${(1000 / mean).toFixed(0)}fps), p95 ${p95.toFixed(1)}ms`,
  );
  // 60fps is 16.7ms a frame; allow scheduling noise from the test driver.
  expect(mean).toBeLessThan(18.5);
  expect(p95).toBeLessThan(34);
});
