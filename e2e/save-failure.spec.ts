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
  // The toast says so too (the open modal hides it from the accessibility tree).
  await expect(page.locator('li').filter({ hasText: 'Could not save' })).toBeVisible();
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
  await expect(page.locator('h1')).toHaveText('Rowan Ashdown');
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
  await add.getByRole('combobox', { name: 'Event type' }).click();
  await page.getByRole('option', { name: 'Residence' }).click();
  await add.getByRole('textbox', { name: 'Date' }).fill('1905');
  await add.getByRole('combobox', { name: 'Place' }).fill('Wexmoor, Westmere');
  await add.getByRole('button', { name: 'Save' }).click();
  await expect(add.getByRole('alert')).toContainText('Simulated failure');
  await expect(add.getByRole('combobox', { name: 'Place' })).toHaveValue('Wexmoor, Westmere');
  await restore();
  await add.getByRole('button', { name: 'Try again' }).click();
  await expect(add).toBeHidden();
  await expect(timeline(page).getByText('Wexmoor, Westmere')).toBeVisible();

  restore = await failWrites(page, /\/events\/[^/]+$/, 'PATCH');
  await timeline(page).getByRole('button', { name: 'Edit Death' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit event' });
  await edit.getByRole('combobox', { name: 'Place' }).fill('Ravensholt, Northvale');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit.getByRole('alert')).toContainText('Simulated failure');
  await expect(edit.getByRole('combobox', { name: 'Place' })).toHaveValue('Ravensholt, Northvale');
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

/** Fails matching writes with a 500 after `delay` ms, so a test can act while the save is pending. */
async function failWritesSlowly(page: Page, url: string | RegExp, delay: number) {
  const handler = async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal', message: 'Simulated failure' } }),
    });
  };
  await page.route(url, handler);
  return () => page.unroute(url, handler);
}

test('a second submit while a failing save is pending keeps the dialog and the edits', async ({
  page,
}) => {
  await openSeeded(page, seeded);
  const restore = await failWritesSlowly(page, '**/batch', 600);
  await page.getByRole('button', { name: 'Edit person', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  const given = dialog.getByRole('textbox', { name: 'Given names' }).first();
  await given.fill('Rowena');
  await dialog.getByRole('button', { name: 'Save' }).click();
  // The optimistic update already matches the draft: this used to look like "nothing changed".
  await given.press('Enter');
  await given.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('Simulated failure');
  await expect(dialog).toBeVisible();
  await expect(given).toHaveValue('Rowena');
  await restore();
});

test('focus stays on the submit button through a failed save', async ({ page }) => {
  await openSeeded(page, seeded);
  const restore = await failWrites(page, '**/batch');
  await page.getByRole('button', { name: 'Edit person', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Rowena');
  await dialog.getByRole('button', { name: 'Save' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('Simulated failure');
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeFocused();
  await restore();
});

test('Edit note keeps the text when the save fails, and retries', async ({ page }) => {
  await openSeeded(page, seeded);
  await page.getByRole('tab', { name: 'Notes' }).click();
  await page.getByRole('button', { name: 'Add note' }).click();
  await page.getByRole('textbox', { name: 'New note' }).fill('Kept the mill accounts.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('Kept the mill accounts.')).toBeVisible();

  const restore = await failWrites(page, /\/notes\/[^/]+$/, 'PATCH');
  // The note just added is the last one.
  await page.getByRole('button', { name: 'Edit note', exact: true }).last().click();
  const field = page.getByRole('textbox', { name: 'Note', exact: true });
  await field.fill('Kept the mill accounts until 1902.');
  // From the keyboard (WebKit does not focus a clicked button), so focus can be checked.
  await page.getByRole('button', { name: 'Save note' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Simulated failure');
  await expect(field).toHaveValue('Kept the mill accounts until 1902.');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeFocused();
  await restore();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(field).toBeHidden();
  await expect(page.getByText('Kept the mill accounts until 1902.')).toBeVisible();
});

test('Add relative with an existing person keeps the choice and retries', async ({ page }) => {
  await openSeeded(page, seeded, seeded.iris);
  const restore = await failWrites(page, '**/spouses', 'POST');
  await relationships(page).getByRole('button', { name: 'Add family member' }).click();
  await page.getByRole('menuitem', { name: 'Add spouse' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add spouse' });
  await dialog.getByRole('radio', { name: 'Existing person' }).check();
  await dialog.getByRole('combobox', { name: 'Person' }).click();
  await page.keyboard.type('Wendell');
  await page.getByRole('option', { name: /Wendell Quarrier/ }).click();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Simulated failure');
  await expect(dialog.getByRole('radio', { name: 'Existing person' })).toBeChecked();
  await expect(dialog.getByRole('combobox', { name: 'Person' })).toContainText('Wendell Quarrier');
  await restore();
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog).toBeHidden();
  await expect(relationships(page).getByRole('link', { name: /Wendell Quarrier/ })).toBeVisible();
});

test('a save that finishes after Cancel does not close the next dialog', async ({ page }) => {
  await openSeeded(page, seeded);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/people\/[^/]+\/events$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await held;
    await route.fallback();
  });
  await timeline(page).getByRole('button', { name: 'Add event' }).click();
  const first = page.getByRole('dialog', { name: 'Add event' });
  await first.getByRole('combobox', { name: 'Event type' }).click();
  await page.getByRole('option', { name: 'Residence' }).click();
  await first.getByRole('textbox', { name: 'Date' }).fill('1905');
  await first.getByRole('button', { name: 'Save' }).click();
  await first.getByRole('button', { name: 'Cancel' }).click();
  await expect(first).toBeHidden();

  await timeline(page).getByRole('button', { name: 'Add event' }).click();
  const second = page.getByRole('dialog', { name: 'Add event' });
  await expect(second).toBeVisible();
  const saved = page.waitForResponse(
    (r) => /\/events$/.test(r.url()) && r.request().method() === 'POST',
  );
  release();
  await saved;
  // Give the late onDone its chance to (wrongly) close the new dialog.
  await page.waitForTimeout(500);
  await expect(second).toBeVisible();
  await second.getByRole('button', { name: 'Cancel' }).click();
  await expect(timeline(page).getByText('1905').first()).toBeVisible();
});

test('a server validation error reads as a plain sentence in every dialog, never schema text', async ({
  page,
}) => {
  await openSeeded(page, seeded);
  const refuse = (route: Route) =>
    route.request().method() === 'GET'
      ? route.fallback()
      : route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'validation_failed',
              message:
                'body/operations/0/name/surname must NOT have more than 200 characters, body/operations/0/name/surname must be null',
            },
          }),
        });
  await page.route(/\/batch$|\/children$/, refuse);

  // Edit person (a batch save).
  await page.getByRole('button', { name: 'Edit person', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit person' });
  await edit.getByRole('textbox', { name: 'Surname' }).first().fill('Ashdowne');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit.getByRole('alert')).toContainText('Surname can be at most 200 characters');
  await expect(edit.getByRole('alert')).not.toContainText('body/');
  await edit.getByRole('button', { name: 'Cancel' }).click();

  // Add relative.
  await relationships(page).getByRole('button', { name: 'Add family member' }).click();
  await page.getByRole('menuitem', { name: 'Add child' }).click();
  const add = page.getByRole('dialog', { name: 'Add child' });
  await add.getByRole('textbox', { name: 'Given names' }).fill('Rollo');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add.getByRole('alert')).toContainText('Surname can be at most 200 characters');
  await expect(add.getByRole('alert')).not.toContainText('body/');
});
