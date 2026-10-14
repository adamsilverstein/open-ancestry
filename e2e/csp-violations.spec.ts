import type { Page } from '@playwright/test';
import { openTree, seedTree } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * Issue #106: nothing the app renders may trip the strict CSP. Every
 * securitypolicyviolation event is recorded from the first script on.
 */

interface Violation {
  directive: string;
  source: string;
  sample: string;
}

async function recordViolations(page: Page): Promise<() => Promise<Violation[]>> {
  await page.addInitScript(() => {
    const list: Violation[] = [];
    (window as unknown as { __cspViolations: Violation[] }).__cspViolations = list;
    document.addEventListener('securitypolicyviolation', (event) => {
      list.push({
        directive: event.violatedDirective,
        source: `${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`,
        sample: event.sample,
      });
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __cspViolations: Violation[] }).__cspViolations);
}

test('the people list, a Select and the palette open without CSP violations', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const violations = await recordViolations(page);
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

  expect(await violations()).toEqual([]);
});

test('the tree view and a person page load without CSP violations', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const violations = await recordViolations(page);
  const seeded = await seedTree(request, baseURL!, `${testInfo.project.name} csp pages`);
  await openTree(page, seeded.tree, `/person/${seeded.rowan}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rowan Ashdown');
  await page.goto(`/tree/${seeded.rowan}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Family tree' })).toBeAttached();
  expect(await violations()).toEqual([]);
});
