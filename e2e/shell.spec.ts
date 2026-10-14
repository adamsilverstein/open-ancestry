import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Navigates and waits until the shell's global shortcuts are listening. */
async function gotoReady(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('html[data-shell-ready]')).toBeAttached();
}

/** Resolved background color of the page, to prove the theme tokens switched. */
function bodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test.describe('navigation', () => {
  test('home shows the import empty state', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Import your Ancestry GEDCOM' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import GEDCOM' })).toBeVisible();
  });

  test('import CTA announces that import is not available yet', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Import GEDCOM' }).click();
    await expect(
      page
        .getByRole('region', { name: /Notifications/ })
        .getByRole('listitem')
        .filter({ hasText: 'Import is coming soon' }),
    ).toBeVisible();
  });

  test('top bar links home and shows the open tree name', async ({ page }) => {
    await page.goto('/design');
    const banner = page.getByRole('banner');
    await expect(banner.getByText('Ashdown family')).toBeVisible();
    await banner.getByRole('link', { name: 'open-ancestry home' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Import your Ancestry GEDCOM');
  });

  test('file menu lists import and export placeholders', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'File' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /Import GEDCOM/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Export GEDCOM/ })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(page.getByRole('button', { name: 'File' })).toBeFocused();
  });

  test('tree route renders a sized skeleton', async ({ page }) => {
    await page.goto('/tree/I1');
    await expect(page.getByRole('heading', { level: 1, name: 'Family tree' })).toBeAttached();
    const region = page.getByRole('region', { name: 'Family tree' });
    await expect(region).toHaveAttribute('aria-busy', 'true');
    await expect(region.getByTestId('skeleton').first()).toBeVisible();
  });

  test('unknown routes show a 404 with a way home', async ({ page }) => {
    await page.goto('/no/such/page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await page.getByRole('link', { name: 'Go home' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Import your Ancestry GEDCOM');
  });
});

test.describe('theme', () => {
  test('follows the system preference by default', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    expect(await bodyBackground(page)).toBe('rgb(20, 23, 28)');
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await bodyBackground(page)).toBe('rgb(250, 248, 244)');
  });

  test('toggle overrides the system theme and persists across reloads', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await bodyBackground(page)).toBe('rgb(20, 23, 28)');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await bodyBackground(page)).toBe('rgb(20, 23, 28)');

    // Toggling back to the system scheme clears the override instead of pinning light.
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    expect(await page.evaluate(() => localStorage.getItem('oa-theme'))).toBeNull();
    expect(await bodyBackground(page)).toBe('rgb(250, 248, 244)');
  });

  test('applies a stored theme before first paint', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(() => localStorage.setItem('oa-theme', 'dark'));
    await page.goto('/');
    // A blocking classic script in <head> sets the theme before the body is parsed.
    await expect(
      page.locator(
        'head script[src$="theme-init.js"]:not([defer]):not([async]):not([type="module"])',
      ),
    ).toHaveCount(1);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('command palette', () => {
  test('opens with Cmd/Ctrl-K, closes with Escape and restores focus', async ({ page }) => {
    await gotoReady(page, '/');
    const trigger = page.getByRole('button', { name: 'Import GEDCOM' });
    await trigger.focus();
    await page.keyboard.press(`${modKey}+k`);
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox')).toBeFocused();

    await page.keyboard.type('zzzz-nobody');
    await expect(dialog.getByText('No results')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('Cmd/Ctrl-K toggles the palette closed', async ({ page }) => {
    await gotoReady(page, '/');
    await page.keyboard.press(`${modKey}+k`);
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press(`${modKey}+k`);
    await expect(dialog).toBeHidden();
  });

  test('Find button opens the palette and actions navigate', async ({ page }) => {
    await gotoReady(page, '/');
    await page.getByRole('banner').getByRole('button', { name: /^Find/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await page.keyboard.type('design');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/design$/);
  });

  test('theme action toggles the theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await gotoReady(page, '/');
    await page.keyboard.press(`${modKey}+k`);
    await expect(
      page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox'),
    ).toBeFocused();
    await page.keyboard.type('theme');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('fonts and network', () => {
  test('makes no third-party requests and preloads the UI font', async ({ page, baseURL }) => {
    const origins = new Set<string>();
    page.on('request', (req) => origins.add(new URL(req.url()).origin));
    await page.goto('/design');
    await expect(page.getByRole('heading', { level: 1, name: 'Design system' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect([...origins].filter((o) => o !== new URL(baseURL!).origin && o !== 'null')).toEqual([]);

    const preload = page.locator('link[rel="preload"][as="font"]');
    await expect(preload).toHaveCount(1);
    await expect(preload).toHaveAttribute('href', /inter-latin-wght-normal.*\.woff2$/);
    await expect(preload).toHaveAttribute('crossorigin', '');
    expect(await page.evaluate(() => document.fonts.check('16px "Inter Variable"'))).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('16px "Source Serif 4 Variable"'))).toBe(
      true,
    );
  });
});

test.describe('performance', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'LCP and CLS entries are Chromium only',
  );

  test('home LCP under 1s with no layout shift', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const { lcp, cls } = await page.evaluate(
      () =>
        new Promise<{ lcp: number; cls: number }>((resolve) => {
          let lcp = 0;
          let cls = 0;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) lcp = entry.startTime;
          }).observe({ type: 'largest-contentful-paint', buffered: true });
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as (PerformanceEntry & { value: number })[]) {
              cls += entry.value;
            }
          }).observe({ type: 'layout-shift', buffered: true });
          setTimeout(() => resolve({ lcp, cls }), 500);
        }),
    );
    expect(lcp).toBeGreaterThan(0);
    expect(lcp).toBeLessThan(1000);
    expect(cls).toBeLessThan(0.01);
  });
});
