import type { Page } from '@playwright/test';
import { openSeeded, seedTree, send, session, type SeededTree } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * Edits to a tree run one at a time, in the order they were made (#144), and
 * undo and redo wait for edits still on their way (#145). Each test slows one
 * request down to stand in for a slow write.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
let seeded: SeededTree;
let tagId: string;

test.beforeEach(async ({ request, baseURL }, testInfo) => {
  seeded = await seedTree(request, baseURL!, `${testInfo.project.name} ${testInfo.title}`);
  const s = await session(request, baseURL!);
  const { tag } = await send<{ tag: { id: string } }>(
    request,
    s,
    'post',
    `/api/trees/${encodeURIComponent(seeded.tree)}/tags`,
    { name: 'Brick wall' },
  );
  tagId = tag.id;
});

const toasts = (page: Page) =>
  page.getByRole('region', { name: /Notifications/ }).getByRole('listitem');

/** Rowan's tags and the latest change, straight from the server. */
async function serverState(page: Page) {
  const base = `/api/trees/${encodeURIComponent(seeded.tree)}`;
  const detail = (await (await page.request.get(`${base}/people/${seeded.rowan}`)).json()) as {
    tags: { id: string }[];
  };
  const history = (await (await page.request.get(`${base}/history?limit=1`)).json()) as {
    items: { label: string; state: string }[];
  };
  return {
    tagged: detail.tags.some((t) => t.id === tagId),
    latest: `${history.items[0]?.label}: ${history.items[0]?.state}`,
  };
}

/** Holds the first request matching `pattern` (any method) for `ms`. */
async function delayFirst(page: Page, pattern: RegExp, ms: number) {
  let first = true;
  await page.route(pattern, async (route) => {
    if (first) {
      first = false;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    await route.continue();
  });
}

test('rapid check then uncheck ends unchecked, with no error', async ({ page }) => {
  await openSeeded(page, seeded);
  await delayFirst(page, /\/people\/[^/]+\/tags/, 800);
  await page.getByRole('button', { name: 'Edit tags' }).click();
  const box = page.getByRole('checkbox', { name: 'Brick wall' });
  await box.check();
  await box.uncheck();
  await expect(box).not.toBeChecked();
  await expect
    .poll(async () => (await serverState(page)).latest, { timeout: 10_000 })
    .toMatch(/^Untag Rowan Ashdown: Brick wall: applied$/);
  expect((await serverState(page)).tagged).toBe(false);
  await expect(box).not.toBeChecked();
  await expect(toasts(page).filter({ hasText: 'Could not save' })).toHaveCount(0);
});

test('Cmd/Ctrl-Z right after a slow edit undoes that edit', async ({ page }) => {
  await openSeeded(page, seeded);
  await page.getByRole('button', { name: 'Edit tags' }).click();
  const box = page.getByRole('checkbox', { name: 'Brick wall' });
  await box.check();
  await expect.poll(async () => (await serverState(page)).tagged).toBe(true);

  await delayFirst(page, /\/people\/[^/]+\/tags/, 800);
  await box.uncheck();
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${mod}+z`);
  await expect(
    toasts(page).filter({ hasText: 'Undid Untag Rowan Ashdown: Brick wall' }),
  ).toBeVisible({ timeout: 10_000 });
  const after = await serverState(page);
  expect(after.tagged).toBe(true);
  expect(after.latest).toBe('Untag Rowan Ashdown: Brick wall: undone');
  await expect(toasts(page).filter({ hasText: 'Could not save' })).toHaveCount(0);
});

test('History Undo and Redo wait for a slow edit', async ({ page }) => {
  await openSeeded(page, seeded);
  await page.getByRole('button', { name: 'Edit tags' }).click();
  await delayFirst(page, /\/people\/[^/]+\/tags/, 2500);
  await page.getByRole('checkbox', { name: 'Brick wall' }).check();
  await page.keyboard.press('Escape');

  await page.getByRole('banner').getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'History' });
  await history.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => (await serverState(page)).latest, { timeout: 10_000 })
    .toBe('Tag Rowan Ashdown: Brick wall: undone');
  expect((await serverState(page)).tagged).toBe(false);

  await delayFirst(page, /\/people\/[^/]+\/tags/, 2500);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Edit tags' }).click();
  await page.getByRole('checkbox', { name: 'Brick wall' }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('banner').getByRole('button', { name: 'History', exact: true }).click();
  await history.getByRole('button', { name: 'Undo' }).click();
  await history.getByRole('button', { name: 'Redo' }).click();
  await expect
    .poll(async () => (await serverState(page)).latest, { timeout: 10_000 })
    .toBe('Tag Rowan Ashdown: Brick wall: applied');
  expect((await serverState(page)).tagged).toBe(true);
});
