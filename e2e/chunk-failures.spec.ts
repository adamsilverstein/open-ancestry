import { expect, test } from './fixtures';
import { readSeed } from './tree-view-fixtures';

/*
 * Lazy chunks can fail to load: the server is unreachable, or it restarted
 * with a new build so the old chunk hashes are gone. That must never take
 * the whole app down.
 */

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

test('a toast still shows when its chunk cannot load', async ({ page }) => {
  await page.route(/\/assets\/ToastStack-[^/]+\.js$/, (route) => route.abort());
  await page.goto('/design');
  await page.getByRole('button', { name: 'Show toast' }).click();
  const shown = page.getByTestId('toast-fallback').filter({ hasText: 'Changes saved' });
  await expect(shown).toBeVisible();
  // Announced through a polite status region.
  await expect(page.getByRole('status').filter({ hasText: 'Changes saved' })).toHaveCount(1);
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Design system' })).toBeVisible();
  // It goes away on its own like a real toast.
  await expect(shown).toBeHidden({ timeout: 10_000 });
});

test('a route whose chunk is gone offers a reload instead of crashing', async ({ page }) => {
  await page.route(/\/assets\/DesignPage-[^/]+\.js$/, (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('html[data-shell-ready]')).toBeAttached();
  await page.goto('/design');
  await expect(page.getByRole('heading', { level: 1, name: /new version/i })).toBeVisible();
  await expect(page.getByRole('banner')).toBeVisible();
  // After a real update the reloaded page asks for the new chunk names.
  const reloaded = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Reload' }).click();
  await reloaded;
});

test('the shell keeps working when the palette chunk cannot load', async ({ page }) => {
  await page.route(/\/assets\/ShellCommandPalette-[^/]+\.js$/, (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('html[data-shell-ready]')).toBeAttached();
  await page.keyboard.press(`${modKey}+k`);
  await page.waitForTimeout(500);
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('a tree busy in another process gets its own page, and Try again recovers', async ({
  page,
}) => {
  // `open-ancestry import` or another server's upgrade holds the tree's lock.
  let busy = true;
  await page.route(/\/api\/trees$/, (route) =>
    busy
      ? route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'conflict',
              message: 'The tree is busy (an import is running); try again when it finishes',
            },
          }),
        })
      : route.fallback(),
  );
  const { tree, ids } = readSeed().family;
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto(`/person/${Object.values(ids)[0]}`);
  await expect(page.getByRole('heading', { level: 1, name: 'This tree is busy' })).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  busy = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'This tree is busy' })).toHaveCount(0);
});
