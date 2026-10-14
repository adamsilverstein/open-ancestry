import type { Page, Route } from '@playwright/test';
import { openSeeded, seedTree, type SeededTree } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * Issue #109: when a save fails, the dialog (or note form) stays open with
 * what was typed and says why, and saving again works once the server does.
 */

let seeded: SeededTree;

test.beforeEach(async ({ request, baseURL }, testInfo) => {
  seeded = await seedTree(request, baseURL!, `${testInfo.project.name} ${testInfo.title}`);
});

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const timeline = (page: Page) => page.getByRole('region', { name: 'Timeline', exact: true });
const relationships = (page: Page) =>
  page.getByRole('region', { name: 'Relationships', exact: true });
const toasts = (page: Page) =>
  page.getByRole('region', { name: /Notifications/ }).getByRole('listitem');

/** Fails matching writes with a 500 until the returned function is called. */
async function failWrites(page: Page, url: string | RegExp, method?: string) {
  const handler = (route: Route) =>
    method && route.request().method() !== method
      ? route.fallback()
      : route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal', message: 'Simulated failure' } }),
        });
  await page.route(url, handler);
  return () => page.unroute(url, handler);
}

test('Add relative keeps the typed person and retries', async ({ page }) => {
  await openSeeded(page, seeded);
  const restore = await failWrites(page, '**/children');
  await relationships(page).getByRole('button', { name: 'Add family member' }).click();
  await page.getByRole('menuitem', { name: 'Add child' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add child' });
  await dialog.getByRole('textbox', { name: 'Given names' }).fill('Rollo');
  await dialog.getByRole('textbox', { name: 'Surname' }).fill('Failwood');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(dialog.getByRole('alert')).toContainText('Simulated failure');
  await expect(toasts(page).filter({ hasText: 'Could not save' })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Given names' })).toHaveValue('Rollo');
  await expect(dialog.getByRole('textbox', { name: 'Surname' })).toHaveValue('Failwood');

  await restore();
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog).toBeHidden();
  await expect(relationships(page).getByRole('link', { name: /Rollo Failwood/ })).toBeVisible();
});

test('Edit person keeps the edits after the rollback and retries', async ({ page }) => {
  await openSeeded(page, seeded);
  const restore = await failWrites(page, '**/batch');
  await page.getByRole('button', { name: 'Edit person', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  const given = dialog.getByRole('textbox', { name: 'Given names' }).first();
  await given.fill('Rowena');
  await dialog.getByRole('button', { name: 'Save' }).click();

  await expect(dialog.getByRole('alert')).toContainText('Simulated failure');
  // The page rolls back to what is stored; the form keeps what was typed.
  await expect(h1(page)).toHaveText('Rowan Ashdown');
  await expect(given).toHaveValue('Rowena');

  await restore();
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog).toBeHidden();
  await expect(h1(page)).toHaveText('Rowena Ashdown');
});

test('Add event and Edit event keep their fields and retry', async ({ page }) => {
  await openSeeded(page, seeded);
  let restore = await failWrites(page, /\/people\/[^/]+\/events$/, 'POST');
  await timeline(page).getByRole('button', { name: 'Add event' }).click();
  const add = page.getByRole('dialog', { name: 'Add event' });
  await add.getByRole('textbox', { name: 'Date' }).fill('1905');
  await add.getByRole('textbox', { name: 'Place' }).fill('Wexmoor, Westmere');
  await add.getByRole('button', { name: 'Save' }).click();
  await expect(add.getByRole('alert')).toContainText('Simulated failure');
  await expect(add.getByRole('textbox', { name: 'Place' })).toHaveValue('Wexmoor, Westmere');
  await restore();
  await add.getByRole('button', { name: 'Try again' }).click();
  await expect(add).toBeHidden();
  await expect(timeline(page).getByText('Wexmoor, Westmere')).toBeVisible();

  restore = await failWrites(page, /\/events\/[^/]+$/, 'PATCH');
  await timeline(page).getByRole('button', { name: 'Edit Death' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit event' });
  await edit.getByRole('textbox', { name: 'Place' }).fill('Ravensholt, Northvale');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit.getByRole('alert')).toContainText('Simulated failure');
  await expect(edit.getByRole('textbox', { name: 'Place' })).toHaveValue('Ravensholt, Northvale');
  await restore();
  await edit.getByRole('button', { name: 'Try again' }).click();
  await expect(edit).toBeHidden();
  await expect(timeline(page).getByText('Ravensholt, Northvale')).toBeVisible();
});

test('a note that fails to save stays in its form', async ({ page }) => {
  await openSeeded(page, seeded);
  await page.getByRole('tab', { name: 'Notes' }).click();
  const restore = await failWrites(page, /\/notes$/, 'POST');
  await page.getByRole('button', { name: 'Add note' }).click();
  const field = page.getByRole('textbox', { name: 'New note' });
  await field.fill('Kept the mill accounts.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByRole('alert')).toContainText('Simulated failure');
  await expect(field).toHaveValue('Kept the mill accounts.');
  await restore();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(field).toBeHidden();
  await expect(page.getByText('Kept the mill accounts.')).toBeVisible();
});
