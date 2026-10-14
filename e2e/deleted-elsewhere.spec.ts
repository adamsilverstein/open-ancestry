import type { Page } from '@playwright/test';
import { openSeeded, seedTree, session, type SeededTree } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * A person deleted in another tab, or by undo, while this tab edits them
 * (#189): one plain message without internal ids, no retry that cannot
 * succeed, and the page moves to a relative instead of the import screen.
 */

let seeded: SeededTree;

test.beforeEach(async ({ request, baseURL }, testInfo) => {
  seeded = await seedTree(request, baseURL!, `${testInfo.project.name} ${testInfo.title}`);
});

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const toasts = (page: Page) =>
  page.getByRole('region', { name: /Notifications/ }).getByRole('listitem');
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;

async function deleteInUi(page: Page, name: string) {
  await page.getByRole('button', { name: 'Edit person' }).click();
  await page
    .getByRole('dialog', { name: 'Edit person' })
    .getByRole('button', { name: 'Delete person' })
    .click();
  await page
    .getByRole('alertdialog', { name: `Delete ${name}?` })
    .getByRole('button', { name: 'Delete person' })
    .click();
}

test('saving an edit to a deleted person explains it', async ({ page, request, baseURL }) => {
  await openSeeded(page, seeded);
  await page.getByRole('button', { name: 'Edit person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Ghost');

  // Deleted where this tab cannot hear it (another device, a script).
  const { headers } = await session(request, baseURL!);
  const res = await request.delete(
    `/api/trees/${encodeURIComponent(seeded.tree)}/people/${seeded.rowan}`,
    { headers },
  );
  expect(res.ok()).toBe(true);

  await dialog.getByRole('button', { name: 'Save' }).click();
  const message = toasts(page).filter({
    hasText: 'Rowan Ashdown was deleted (in another window or by undo)',
  });
  await expect(message).toBeVisible();
  await expect(message).toContainText("Your changes couldn't be saved");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  for (const text of await toasts(page).allInnerTexts()) expect(text).not.toMatch(ULID);
  await expect(toasts(page)).toHaveCount(1);

  // The nearest relative: a parent.
  await expect(page).toHaveURL(new RegExp(`/person/${seeded.edmund}$`));
  await expect(h1(page)).toHaveText('Edmund Ashdown');
});

test('a deleted person page moves to a relative', async ({ page }) => {
  const a = page;
  const b = await page.context().newPage();
  await openSeeded(a, seeded);
  await openSeeded(b, seeded);

  await deleteInUi(b, 'Rowan Ashdown');

  await expect(
    toasts(a).filter({ hasText: 'Rowan Ashdown was deleted (in another window or by undo)' }),
  ).toBeVisible();
  await expect(a).toHaveURL(new RegExp(`/person/${seeded.edmund}$`));
  await expect(h1(a)).toHaveText('Edmund Ashdown');
});

test('a deleted person with no relatives leads to the people list', async ({ page }) => {
  const a = page;
  const b = await page.context().newPage();
  await openSeeded(a, seeded, seeded.wendell);
  await openSeeded(b, seeded, seeded.wendell);
  await deleteInUi(b, 'Wendell Quarrier');
  await expect(
    toasts(a).filter({ hasText: 'Wendell Quarrier was deleted (in another window or by undo)' }),
  ).toBeVisible();
  await expect(a).toHaveURL(/\/people$/);
});
