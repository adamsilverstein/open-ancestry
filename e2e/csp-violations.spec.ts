import { openTree, seedTree } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * Issue #106: nothing the app renders may trip the strict CSP. The cspGuard
 * fixture (fixtures.ts) records every securitypolicyviolation event from the
 * first script on, across navigations, and fails the test at teardown.
 */

test('the people list, a Select and the palette open without CSP violations', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seedTree(request, baseURL!, `${testInfo.project.name} csp`);
  await openTree(page, seeded.tree, '/people');
  await expect(page.getByTestId('people-count')).toHaveText('5 people');

  await page.getByRole('combobox', { name: 'Sex' }).click();
  await expect(page.getByRole('listbox')).toBeVisible();
  // The viewport style the Select injects must apply: no scrollbar on the list.
  const scrollbar = await page
    .locator('[data-radix-select-viewport]')
    .evaluate((el) => getComputedStyle(el).scrollbarWidth);
  expect(scrollbar).toBe('none');
  await page.keyboard.press('Escape');

  await page.getByRole('banner').getByRole('button', { name: /^Find/ }).click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.keyboard.type('Rowan');
  await expect(page.getByRole('option', { name: /Rowan Ashdown/ })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('the tree view and a person page load without CSP violations', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seedTree(request, baseURL!, `${testInfo.project.name} csp pages`);
  await openTree(page, seeded.tree, `/person/${seeded.rowan}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rowan Ashdown');
  await page.goto(`/tree/${seeded.rowan}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Family tree' })).toBeAttached();
});

test.describe('the CSP guard itself', () => {
  /** Adds an un-nonced <style> and waits until the browser reports it. */
  const violate = (page: import('@playwright/test').Page) =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          document.addEventListener('securitypolicyviolation', () => resolve(), { once: true });
          const style = document.createElement('style');
          style.textContent = 'body { outline: 0 }';
          document.head.append(style);
        }),
    );

  test('fails a test whose violation happened on a page it then left', async ({ page }) => {
    // Expected to fail: the guard must still see the violation after the navigation.
    test.fail();
    await page.goto('/people');
    await violate(page);
    await page.goto('/');
    await expect(page.getByRole('banner')).toBeVisible();
  });

  test('fails a test whose violation happened before a reload', async ({ page }) => {
    test.fail();
    await page.goto('/');
    await violate(page);
    await page.reload();
    await expect(page.getByRole('banner')).toBeVisible();
  });
});
