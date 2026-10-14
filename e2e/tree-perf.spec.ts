import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { readSeed } from './tree-view-fixtures';

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
    /** Cards inside the viewport, painted or mounted. */
    visible: Number(await world.getAttribute('data-visible-count')),
    mounted: await canvas(page).locator('[data-key]').count(),
  };
}

async function settled(page: Page) {
  await expect(page.getByTestId('tree-world')).not.toHaveAttribute('data-animating');
}

test.use({ viewport: { width: 1440, height: 900 } });

test('re-focus with cached data takes under 50ms with ~500 people on screen', async ({ page }) => {
  // The founder has seven generations of descendants: over a thousand cards.
  const extra = '&down=7&up=1';
  await page.goto(url(perf.founderId, extra));
  await ready(page);
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  await settled(page);
  const { laidOut } = await layoutStats(page);

  // Keyboard: down to a child, Enter to re-focus, up to the founder, Enter again.
  // The first round trip loads both neighborhoods; later ones are cached.
  const activeKey = () =>
    page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key ?? null);
  await canvas(page).locator(`[data-key="${perf.founderId}"]`).focus();
  const visibleCounts: number[] = [];
  const refocus = async (key: string) => {
    await page.keyboard.press(key);
    const before = (await lastRefocus(page))?.count ?? 0;
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await lastRefocus(page))?.count ?? 0).toBeGreaterThan(before);
    await ready(page);
    await settled(page);
    visibleCounts.push((await layoutStats(page)).visible);
    return (await lastRefocus(page))!.duration;
  };
  await refocus('ArrowDown');
  const child = await activeKey();
  expect(child).not.toBe(perf.founderId);
  await refocus('ArrowUp');
  expect(await activeKey()).toBe(perf.founderId);

  const durations: number[] = [];
  visibleCounts.length = 0;
  for (let i = 0; i < 3; i++) {
    durations.push(await refocus('ArrowDown'));
    expect(await activeKey()).toBe(child);
    durations.push(await refocus('ArrowUp'));
  }
  durations.sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)]!;
  const meanVisible = Math.round(visibleCounts.reduce((a, b) => a + b, 0) / visibleCounts.length);
  console.log(
    `re-focus (cached), ${laidOut} laid out, ${meanVisible} on screen on average (${Math.min(...visibleCounts)}-${Math.max(...visibleCounts)}): median ${median.toFixed(1)}ms, all ${durations.map((d) => d.toFixed(1)).join(', ')}`,
  );
  expect(meanVisible).toBeGreaterThanOrEqual(500);
  expect(median).toBeLessThan(50);
});

function frameRecorder(page: Page) {
  return {
    start: () =>
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
      }),
    stop: async () => {
      const frames = await page.evaluate(() => {
        const w = window as unknown as { __frames: number[]; __stop: boolean };
        w.__stop = true;
        return w.__frames.slice(2);
      });
      frames.sort((a, b) => a - b);
      const mean = frames.reduce((s, f) => s + f, 0) / frames.length;
      return { count: frames.length, mean, p95: frames[Math.floor(frames.length * 0.95)]! };
    },
  };
}

/** One pointer move per frame across the canvas and back, then pinch out and in. */
async function panAndPinch(page: Page) {
  const box = (await canvas(page).boundingBox())!;
  const minVisible = { value: Infinity };
  const sample = async () => {
    const v = Number(await page.getByTestId('tree-world').getAttribute('data-visible-count'));
    minVisible.value = Math.min(minVisible.value, v);
  };
  await page.mouse.move(box.x + box.width - 200, box.y + 300);
  await page.mouse.down();
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(box.x + box.width - 200 - i * 12, box.y + 300 + (i % 10) * 4);
    if (i % 15 === 0) await sample();
  }
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(box.x + box.width - 920 + i * 12, box.y + 340 - (i % 10) * 4);
    if (i % 15 === 0) await sample();
  }
  await page.mouse.up();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 20);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -20);
  await page.keyboard.up('Control');
  await sample();
  return minVisible.value;
}

for (const scenario of [
  {
    name: '41% zoom over the lower generations, cards mounted',
    // Four zoom steps out from 100% (41%): just above the canvas level of detail, so every
    // card is DOM. Arrow down into the dense lower generations first.
    prepare: async (page: Page) => {
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('ArrowDown');
        await settled(page);
      }
      for (let i = 0; i < 4; i++) await page.keyboard.press('-');
    },
    // This descendant chart is sparse at 41%; the DOM cap by design is about 300 cards
    // (a 1440x900 viewport of 120x150 cards at the 35% threshold).
    minVisible: 25,
    minMounted: 25,
  },
  {
    name: 'fit, with every card on screen',
    prepare: async (page: Page) => {
      await page.keyboard.press('0');
    },
    minVisible: 2000,
    minMounted: 0,
  },
]) {
  test(`pans and zooms at 60fps with 2,000+ laid-out cards: ${scenario.name}`, async ({ page }) => {
    await page.goto(url(perf.founderId, '&down=8&up=1'));
    await ready(page);
    await canvas(page).locator(`[data-key="${perf.founderId}"]`).focus();
    await scenario.prepare(page);
    await settled(page);
    const before = await layoutStats(page);
    expect(before.laidOut).toBeGreaterThanOrEqual(2000);
    expect(before.visible).toBeGreaterThanOrEqual(scenario.minVisible);
    expect(before.mounted).toBeGreaterThanOrEqual(scenario.minMounted);

    const frames = frameRecorder(page);
    await frames.start();
    const minVisible = await panAndPinch(page);
    const { count, mean, p95 } = await frames.stop();
    console.log(
      `pan/zoom (${scenario.name}), ${before.laidOut} laid out, ${before.visible} on screen, ${before.mounted} mounted (min ${minVisible} on screen while moving): ${count} frames, mean ${mean.toFixed(1)}ms (${(1000 / mean).toFixed(0)}fps), p95 ${p95.toFixed(1)}ms`,
    );
    // 60fps is 16.7ms a frame; allow scheduling noise from the test driver.
    expect(mean).toBeLessThan(18.5);
    expect(p95).toBeLessThan(25);
  });
}
