import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

test('loads the app shell', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('open-ancestry');
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Import your Ancestry GEDCOM' }),
  ).toBeVisible();
});

test('deep links fall back to the SPA', async ({ page }) => {
  await page.goto('/tree/some-person');
  await expect(page.getByRole('heading', { level: 1, name: 'Family tree' })).toBeAttached();
});

test('app shell has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('server health endpoint responds', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  expect(await res.json()).toEqual({ ok: true });
});
