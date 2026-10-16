import type { Page } from '@playwright/test';
import { perfOnly } from './budget';
import { expect, test } from './fixtures';
import { FIXTURE_TREE } from './tree-fixture';
import { readSeed } from './tree-view-fixtures';

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

  test('import CTA opens the file picker', async ({ page }) => {
    await page.goto('/');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import GEDCOM' }).click();
    expect((await chooser).isMultiple()).toBe(false);
  });

  test('top bar links home and shows the open tree in the tree switcher', async ({ page }) => {
    await page.goto('/design');
    const banner = page.getByRole('banner');
    await expect(banner.getByRole('button', { name: /Tree:/ })).toContainText('Ashdown family');
    await banner.getByRole('link', { name: 'open-ancestry home' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Import your Ancestry GEDCOM');
  });

  test('file menu lists import and export', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'File' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /Import GEDCOM/ })).toBeEnabled();
    await expect(menu.getByRole('menuitem', { name: /Export/ })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(page.getByRole('button', { name: 'File' })).toBeFocused();
  });

  test('tree route renders a sized skeleton while the tree loads', async ({ page }) => {
    const { tree, ids } = readSeed().family;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/neighborhood?*', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(`/tree/${ids.ada}?tree=${encodeURIComponent(tree)}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Family tree' })).toBeAttached();
    const canvas = page.getByRole('application', { name: /^Family tree/ });
    await expect(canvas).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.getByTestId('skeleton').first()).toBeVisible();
    release();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    await expect(canvas.getByTestId('skeleton')).toHaveCount(0);
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

  test('keys typed straight after the first Cmd/Ctrl-K reach the input', async ({ page }) => {
    await gotoReady(page, '/');
    await page.keyboard.press(`${modKey}+k`);
    await page.keyboard.type('zzzz-nobody');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog.getByRole('combobox')).toHaveValue('zzzz-nobody');
    await expect(dialog.getByText('No results')).toBeVisible();
  });

  test('keys typed while the palette chunk loads are kept in order, edits included', async ({
    page,
  }) => {
    // A slow chunk makes the gap between the shortcut and the input as wide as on a busy machine.
    await page.route(/\/assets\/ShellCommandPalette-[^/]+\.js$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await gotoReady(page, '/');
    await page.keyboard.press(`${modKey}+k`);
    await page.keyboard.type('zzzx');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('z-');
    const input = page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox');
    await expect(input).toBeFocused();
    await page.keyboard.type('nobody');
    await expect(input).toHaveValue('zzzz-nobody');
  });

  test('typing works again when the palette chunk cannot load', async ({ page }) => {
    await page.route(/\/assets\/ShellCommandPalette-[^/]+\.js$/, (route) => route.abort());
    await gotoReady(page, '/design');
    const field = page.getByRole('textbox').first();
    await page.keyboard.press(`${modKey}+k`);
    await page.waitForTimeout(500);
    await field.focus();
    await page.keyboard.type('still typing');
    await expect(field).toHaveValue('still typing');
  });

  test('after a failed palette chunk, the next Cmd/Ctrl-K opens it and typing still works', async ({
    page,
    browserName,
  }) => {
    // The first request fails (offline), later ones load (back online).
    let failed = false;
    await page.route(/\/assets\/ShellCommandPalette-[^/]+\.js$/, (route) => {
      if (failed) return route.continue();
      failed = true;
      return route.abort();
    });
    await gotoReady(page, '/design');
    await page.keyboard.press(`${modKey}+k`);
    await expect.poll(() => failed).toBe(true);
    await page.waitForTimeout(300);
    // One press tries again, and the keys typed meanwhile land in it. WebKit keeps a
    // failed module import for the page's lifetime, so there it fails again, and the
    // only requirement is that typing is released.
    await page.keyboard.press(`${modKey}+k`);
    await page.keyboard.type('zzzz');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    if (browserName !== 'webkit') {
      await expect(dialog.getByRole('combobox')).toHaveValue('zzzz');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    } else {
      await page.waitForTimeout(300);
    }
    const field = page.getByRole('textbox').first();
    await field.focus();
    await page.keyboard.type('still typing');
    await expect(field).toHaveValue('still typing');
  });

  test('AltGr characters, combining marks and paste typed while the palette loads are kept', async ({
    page,
  }) => {
    await page.route(/\/assets\/ShellCommandPalette-[^/]+\.js$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await gotoReady(page, '/');
    await page.keyboard.press(`${modKey}+k`);
    await page.evaluate(() => {
      const key = (init: KeyboardEventInit) =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
        );
      key({ key: 'a' });
      // AltGr+L on a Polish layout: reported as Ctrl+Alt.
      key({ key: 'ł', ctrlKey: true, altKey: true });
      // A key whose value is two code points (e + combining acute).
      key({ key: 'e\u0301' });
      const data = new DataTransfer();
      data.setData('text/plain', 'zz\nyy');
      window.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      );
    });
    const input = page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox');
    await expect(input).toHaveValue('ał\u00e9zz yy');
  });

  test('a chunk slower than the backstop still gets every key typed while it loads', async ({
    page,
  }) => {
    // The 3s release starts once the chunk has loaded, not at Cmd-K (#175 review).
    await page.route(/\/assets\/ShellCommandPalette-[^/]+\.js$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await route.continue();
    });
    await gotoReady(page, '/');
    await page.keyboard.press(`${modKey}+k`);
    await page.keyboard.type('zz');
    await page.waitForTimeout(3300);
    await page.keyboard.type('zz');
    // Modified arrows (Alt+Left is Back) are never held.
    const held = await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(held).toBe(false);
    const input = page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox');
    await expect(input).toHaveValue('zzzz', { timeout: 10_000 });
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

test.describe('layout stability', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Layout shift entries are Chromium only',
  );

  test('the recent trees list appears without moving anything on the home page', async ({
    page,
  }) => {
    // Hold the tree list until the page has painted with its fonts, so only its arrival is measured.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // A fixed list: parallel specs fill the shared library with trees, and a name with
    // characters outside Latin pulls in another font file whose swap would be measured too.
    const modifiedAt = new Date().toISOString();
    const trees = [FIXTURE_TREE, 'Tree one', 'Tree two', 'Tree three'].map((name) => ({
      id: name,
      name,
      modifiedAt,
    }));
    await page.route('**/api/trees', async (route) => {
      await held;
      await route.fulfill({ json: { trees } });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Fonts swap in when they finish loading; let that layout land before measuring.
    const since = await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now();
    });
    release();
    await expect(page.getByRole('navigation', { name: 'Recent trees' })).toBeVisible();
    // Every element that moved after the list arrived, so a failure says what shifted.
    const moved = await page.evaluate(
      (after) =>
        new Promise<string[]>((resolve) => {
          const out: string[] = [];
          type Shift = PerformanceEntry & { sources: { node?: Node | null }[] };
          new PerformanceObserver((list) => {
            for (const e of list.getEntries() as Shift[]) {
              if (e.startTime < after) continue;
              for (const { node } of e.sources) {
                const el = node instanceof Element ? node : node?.parentElement;
                out.push(
                  `${el?.tagName ?? '?'} "${(node?.textContent ?? '').trim().slice(0, 40)}"`,
                );
              }
            }
          }).observe({ type: 'layout-shift', buffered: true });
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(out)));
        }),
      since,
    );
    expect(moved).toEqual([]);
  });
});

test.describe('performance', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'LCP and CLS entries are Chromium only',
  );
  test.skip(perfOnly(), 'Run with npm run e2e:perf');

  test('home LCP under 1s with no layout shift', { tag: '@perf' }, async ({ page }) => {
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
    // Not scaled by OA_BENCH_FACTOR: an uninstrumented single-worker run measures about
    // 120-180ms even on a loaded machine, so 1s holds as written.
    expect(lcp).toBeLessThan(1000);
    expect(cls).toBeLessThan(0.01);
  });
});
