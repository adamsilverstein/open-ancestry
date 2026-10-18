import type { Page } from '@playwright/test';
import { openSeeded, seedTree, type SeededTree } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * Partner relationship types and removing wrong links (#115). Seeded tree:
 * Rowan, child of Edmund and Clara, partner of Iris.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
let seeded: SeededTree;

test.beforeEach(async ({ request, baseURL }, testInfo) => {
  seeded = await seedTree(request, baseURL!, `${testInfo.project.name} ${testInfo.title}`);
});

const relationships = (page: Page) =>
  page.getByRole('region', { name: 'Relationships', exact: true });
const group = (page: Page, name: string) =>
  relationships(page).getByRole('region', { name, exact: true });
const toasts = (page: Page) =>
  page.getByRole('region', { name: /Notifications/ }).getByRole('listitem');

/** Latest change batch label, straight from the server. */
async function latestLabel(page: Page): Promise<string> {
  const res = await page.request.get(
    `/api/trees/${encodeURIComponent(seeded.tree)}/history?limit=1`,
  );
  const { items } = (await res.json()) as { items: { label: string }[] };
  return items[0]?.label ?? '';
}

async function groupAction(page: Page, groupName: string, item: string | RegExp) {
  await group(page, groupName)
    .getByRole('button', { name: `Actions for ${groupName}` })
    .click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('Add spouse sets the relationship type', async ({ page }) => {
  await openSeeded(page, seeded);
  await relationships(page).getByRole('button', { name: 'Add family member' }).click();
  await page.getByRole('menuitem', { name: 'Add spouse' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add spouse' });
  await dialog.getByRole('textbox', { name: 'Given names' }).fill('Maren');
  await dialog.getByRole('textbox', { name: 'Surname' }).fill('Holt');
  await dialog.getByRole('combobox', { name: 'Relationship type' }).click();
  await page.getByRole('option', { name: 'Partners' }).click();
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(dialog).toBeHidden();

  const maren = group(page, 'Spouse and children: Maren Holt');
  await expect(maren.getByText('Partners', { exact: true })).toBeVisible();
  // Iris's partnership has no recorded type, so it shows none.
  await expect(group(page, 'Spouse and children: Iris Vale').getByText('Partners')).toHaveCount(0);
});

test('edits a partnership type as one undo step', async ({ page }) => {
  await openSeeded(page, seeded);
  await groupAction(page, 'Spouse and children', 'Edit relationship type…');
  const dialog = page.getByRole('dialog', { name: 'Relationship with Iris Vale' });
  await dialog.getByRole('combobox', { name: 'Relationship type' }).click();
  await page.getByRole('option', { name: 'Married' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    group(page, 'Spouse and children').getByText('Married', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => latestLabel(page))
    .toBe('Edit relationship type: Rowan Ashdown and Iris Vale');

  await page.keyboard.press(`${mod}+z`);
  await expect(
    toasts(page).filter({ hasText: 'Undid Edit relationship type: Rowan Ashdown and Iris Vale' }),
  ).toBeVisible();
  await expect(group(page, 'Spouse and children').getByText('Married')).toHaveCount(0);
});

test('removes a partner link, keeping both people, and undoes it', async ({ page }) => {
  await openSeeded(page, seeded);
  await groupAction(page, 'Spouse and children', 'Remove partner…');
  const confirm = page.getByRole('alertdialog', { name: 'Remove Iris Vale as partner?' });
  await expect(confirm).toContainText('Both people stay in the tree');
  await confirm.getByRole('button', { name: 'Remove partner' }).click();
  await expect(group(page, 'Spouse and children')).toHaveCount(0);
  // The group and its menu are gone, so focus lands on Add family member.
  await expect(
    relationships(page).getByRole('button', { name: 'Add family member' }),
  ).toBeFocused();
  // No children: the partnership itself goes, with its events.
  await expect
    .poll(() => latestLabel(page))
    .toBe('Remove relationship: Rowan Ashdown and Iris Vale');
  const iris = await page.request.get(
    `/api/trees/${encodeURIComponent(seeded.tree)}/people/${seeded.iris}`,
  );
  expect(iris.ok()).toBe(true);

  await page.keyboard.press(`${mod}+z`);
  await expect(
    group(page, 'Spouse and children').getByRole('link', { name: /Iris Vale/ }),
  ).toBeVisible();
});

test('removing a partner who has children keeps the children with the other parent', async ({
  page,
}) => {
  await openSeeded(page, seeded, seeded.edmund);
  await groupAction(page, 'Spouse and children', 'Remove partner…');
  const confirm = page.getByRole('alertdialog', { name: 'Remove Clara Penhallow as partner?' });
  await expect(confirm).toContainText('no longer be a parent of Rowan Ashdown');
  await expect(confirm).toContainText('events (such as a marriage) are removed');
  await confirm.getByRole('button', { name: 'Remove partner' }).click();
  const family = group(page, 'Spouse and children');
  await expect(family.getByRole('link', { name: /Clara Penhallow/ })).toHaveCount(0);
  await expect(family.getByRole('link', { name: /Rowan Ashdown/ })).toBeVisible();
  await expect
    .poll(() => latestLabel(page))
    .toBe('Remove partner: Clara Penhallow from Edmund Ashdown');

  await page.keyboard.press(`${mod}+z`);
  await expect(family.getByRole('link', { name: /Clara Penhallow/ })).toBeVisible();
});

test('removes the link to a set of parents, keeping everyone, and undoes it', async ({ page }) => {
  await openSeeded(page, seeded);
  await groupAction(page, 'Parents', 'Remove from these parents…');
  const confirm = page.getByRole('alertdialog', {
    name: 'Remove Rowan Ashdown from the family of Edmund Ashdown and Clara Penhallow?',
  });
  await expect(confirm).toContainText('Everyone stays in the tree');
  await confirm.getByRole('button', { name: 'Remove link' }).click();
  await expect(group(page, 'Parents')).toHaveCount(0);
  await expect
    .poll(() => latestLabel(page))
    .toBe('Remove child link: Rowan Ashdown from Edmund Ashdown and Clara Penhallow');

  await page.keyboard.press(`${mod}+z`);
  await expect(group(page, 'Parents').getByRole('link', { name: /Edmund Ashdown/ })).toBeVisible();
  await page.keyboard.press(`Shift+${mod}+z`);
  await expect(group(page, 'Parents')).toHaveCount(0);
});

test('removes a child link from the parent page and undoes it', async ({ page }) => {
  await openSeeded(page, seeded, seeded.edmund);
  const family = group(page, 'Spouse and children');
  await expect(family.getByRole('link', { name: /Rowan Ashdown/ })).toBeVisible();
  await family.getByRole('button', { name: 'Actions for Spouse and children' }).click();
  const item = page.getByRole('menuitem', { name: 'Remove child Rowan Ashdown…' });
  // The name is isolated, so a right-to-left name cannot move the ellipsis (#264).
  await expect(item.locator('bdi')).toHaveText('Rowan Ashdown');
  await item.click();
  const confirm = page.getByRole('alertdialog', {
    name: 'Remove Rowan Ashdown from the family of Edmund Ashdown and Clara Penhallow?',
  });
  await confirm.getByRole('button', { name: 'Remove link' }).click();
  await expect(family.getByRole('link', { name: /Rowan Ashdown/ })).toHaveCount(0);
  // The partnership itself stays, and focus returns to the group's menu button.
  await expect(family.getByRole('link', { name: /Clara Penhallow/ })).toBeVisible();
  await expect(
    family.getByRole('button', { name: 'Actions for Spouse and children' }),
  ).toBeFocused();

  await page.keyboard.press(`${mod}+z`);
  await expect(family.getByRole('link', { name: /Rowan Ashdown/ })).toBeVisible();
});

test('removing the last child of a one-parent family removes the empty family', async ({
  page,
}) => {
  await openSeeded(page, seeded, seeded.edmund);
  await groupAction(page, 'Spouse and children', 'Remove partner…');
  await page
    .getByRole('alertdialog', { name: 'Remove Clara Penhallow as partner?' })
    .getByRole('button', { name: 'Remove partner' })
    .click();
  const family = group(page, 'Spouse and children');
  await expect(family.getByRole('link', { name: /Clara Penhallow/ })).toHaveCount(0);

  await groupAction(page, 'Spouse and children', 'Remove child Rowan Ashdown…');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove link' }).click();
  // Nothing is left to show: no empty, unremovable group.
  await expect(family).toHaveCount(0);
  await expect(relationships(page).getByText('No family recorded')).toBeVisible();

  await page.keyboard.press(`${mod}+z`);
  await expect(family.getByRole('link', { name: /Rowan Ashdown/ })).toBeVisible();
});
