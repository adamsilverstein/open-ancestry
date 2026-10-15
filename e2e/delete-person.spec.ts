import type { Page } from '@playwright/test';
import { openSeeded, seedTree, type SeededTree } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * Issue #107: deleting a person lands on a close relative (or the people
 * list), and undoing the delete comes back to the restored person.
 * Seeded: Rowan, child of Edmund and Clara, partner of Iris; Wendell alone.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
let seeded: SeededTree;

test.beforeEach(async ({ request, baseURL }, testInfo) => {
  seeded = await seedTree(request, baseURL!, `${testInfo.project.name} ${testInfo.title}`);
});

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const deletedToast = (page: Page, name: string) =>
  page
    .getByRole('region', { name: /Notifications/ })
    .getByRole('listitem')
    .filter({ hasText: `Deleted ${name}` });

async function deletePerson(page: Page, name: string) {
  await page.getByRole('button', { name: 'Edit person', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await dialog.getByRole('button', { name: 'Delete person' }).click();
  await page
    .getByRole('alertdialog', { name: `Delete ${name}?` })
    .getByRole('button', { name: 'Delete person' })
    .click();
}

test('lands on a parent, and Cmd/Ctrl-Z returns to the restored person', async ({ page }) => {
  await openSeeded(page, seeded);
  await deletePerson(page, 'Rowan Ashdown');
  await expect(page).toHaveURL(new RegExp(`/person/${seeded.edmund}$`));
  await expect(h1(page)).toHaveText('Edmund Ashdown');
  await expect(deletedToast(page, 'Rowan Ashdown')).toBeVisible();

  await page.keyboard.press(`${mod}+z`);
  await expect(page).toHaveURL(new RegExp(`/person/${seeded.rowan}$`));
  await expect(h1(page)).toHaveText('Rowan Ashdown');
});

test('the toast Undo button restores the person and opens them', async ({ page }) => {
  await openSeeded(page, seeded, seeded.iris);
  await deletePerson(page, 'Iris Vale');
  // No parents: her partner is the nearest relative.
  await expect(page).toHaveURL(new RegExp(`/person/${seeded.rowan}$`));
  await deletedToast(page, 'Iris Vale').getByRole('button', { name: 'Undo' }).click();
  await expect(page).toHaveURL(new RegExp(`/person/${seeded.iris}$`));
  await expect(h1(page)).toHaveText('Iris Vale');
});

test('someone with no relatives leaves for the people list', async ({ page }) => {
  await openSeeded(page, seeded, seeded.wendell);
  await deletePerson(page, 'Wendell Quarrier');
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.getByTestId('people-count')).toHaveText('4 people');

  await page.keyboard.press(`${mod}+z`);
  await expect(page).toHaveURL(new RegExp(`/person/${seeded.wendell}$`));
  await expect(h1(page)).toHaveText('Wendell Quarrier');
});

test('undo from the History panel also returns to the restored person', async ({ page }) => {
  await openSeeded(page, seeded);
  await deletePerson(page, 'Rowan Ashdown');
  await expect(page).toHaveURL(new RegExp(`/person/${seeded.edmund}$`));
  await page.getByRole('banner').getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'History' });
  await history.getByRole('button', { name: 'Undo' }).click();
  await expect(page).toHaveURL(new RegExp(`/person/${seeded.rowan}$`));
});

test('the toast Undo refuses once a newer change was made, instead of undoing that', async ({
  page,
}) => {
  await openSeeded(page, seeded);
  await deletePerson(page, 'Rowan Ashdown');
  await expect(h1(page)).toHaveText('Edmund Ashdown');
  // A newer edit before pressing Undo on the delete's toast.
  await page.getByRole('button', { name: 'Edit person', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Edwin');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(h1(page)).toHaveText('Edwin Ashdown');

  await deletedToast(page, 'Rowan Ashdown').getByRole('button', { name: 'Undo' }).click();
  await expect(
    page.getByRole('region', { name: /Notifications/ }).getByText(/Can't undo the delete/),
  ).toBeVisible();
  // Neither the rename nor the delete was undone.
  await expect(h1(page)).toHaveText('Edwin Ashdown');
  await expect(page).toHaveURL(new RegExp(`/person/${seeded.edmund}$`));
  const rowan = await page.request.get(
    `/api/trees/${encodeURIComponent(seeded.tree)}/people/${seeded.rowan}`,
  );
  expect(rowan.status()).toBe(404);
});
