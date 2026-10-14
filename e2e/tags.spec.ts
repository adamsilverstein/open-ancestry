import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { person, send, session, uniqueTreeName } from './edit-seed';
import { expect, test } from './fixtures';

/* Tag management (#57): categories and tags, filtering people and the tree. */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

let tree: string;
let rowan: string;
let iris: string;

test.beforeEach(async ({ request, baseURL }, testInfo) => {
  const s = await session(request, baseURL!);
  tree = uniqueTreeName('tags', `${testInfo.project.name} ${testInfo.title}`);
  await send(request, s, 'post', '/api/trees', { name: tree });
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  rowan = (
    await send<{ person: { id: string } }>(
      request,
      s,
      'post',
      `${base}/people`,
      person('Rowan', 'Ashdown', 'M', '1880'),
    )
  ).person.id;
  iris = (
    await send<{ spouseId: string }>(request, s, 'post', `${base}/people/${rowan}/spouses`, {
      person: person('Iris', 'Vale', 'F', '1885'),
    })
  ).spouseId;
  await send(request, s, 'put', `${base}/home`, { personId: rowan });
  const { tag } = await send<{ tag: { id: string } }>(request, s, 'post', `${base}/tags`, {
    name: 'Smiths',
    category: 'Occupation',
  });
  await send(request, s, 'post', `${base}/people/${rowan}/tags`, { tagId: tag.id });
});

async function openTags(page: Page) {
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto('/tags');
  await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible();
  await page.locator('html[data-shell-ready]').waitFor({ state: 'attached' });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

const category = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('creates, edits, recolors and deletes tags, with undo', async ({ page }) => {
  await openTags(page);
  await page.getByRole('button', { name: 'New tag' }).click();
  let dialog = page.getByRole('dialog', { name: 'New tag' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Brick wall');
  await dialog.getByRole('textbox', { name: 'Category' }).fill('Research');
  await dialog.getByRole('radio', { name: 'Violet' }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(category(page, 'Research').getByText('Brick wall')).toBeVisible();

  await category(page, 'Research').getByRole('button', { name: 'Edit tag Brick wall' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit tag' });
  await expect(dialog.getByRole('radio', { name: 'Violet' })).toBeChecked();
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Brick walls');
  await dialog.getByRole('radio', { name: 'Red' }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(category(page, 'Research').getByText('Brick walls')).toBeVisible();

  await category(page, 'Research').getByRole('button', { name: 'Delete tag Brick walls' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete tag' }).click();
  await expect(category(page, 'Research')).toHaveCount(0);
  await page.keyboard.press(`${mod}+z`);
  await expect(category(page, 'Research').getByText('Brick walls')).toBeVisible();
});

test('renames and deletes a category in one undo step each', async ({ page }) => {
  await openTags(page);
  await category(page, 'Occupation').getByRole('button', { name: 'Rename category' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename category' });
  await dialog.getByRole('textbox', { name: 'Category name' }).fill('Trades');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(category(page, 'Trades').getByText('Smiths')).toBeVisible();

  await category(page, 'Trades').getByRole('button', { name: 'Delete category' }).click();
  const confirm = page.getByRole('alertdialog', {
    name: 'Delete the Trades category and its 1 tag?',
  });
  await confirm.getByRole('button', { name: 'Delete category' }).click();
  await expect(page.getByRole('heading', { name: 'No tags yet' })).toBeVisible();
  await page.keyboard.press(`${mod}+z`);
  await expect(category(page, 'Trades').getByText('Smiths')).toBeVisible();
});

test('filters the people list and highlights the tree by tag', async ({ page }) => {
  await openTags(page);
  const row = category(page, 'Occupation').getByRole('listitem').filter({ hasText: 'Smiths' });
  await expect(row).toContainText('1 person');
  await row.getByRole('link', { name: 'Show people' }).click();
  await expect(page).toHaveURL(/\/people\?.*tag=/);
  await expect(page.getByTestId('people-count')).toHaveText('1 person');

  await page.goBack();
  await category(page, 'Occupation')
    .getByRole('listitem')
    .filter({ hasText: 'Smiths' })
    .getByRole('link', { name: 'Highlight in tree' })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Highlighting people tagged Smiths' }),
  ).toBeVisible();
  const card = (name: RegExp) =>
    page
      .locator('[data-key]')
      .filter({ has: page.locator(`[aria-label]`) })
      .and(page.getByRole('button', { name }));
  await expect(card(/^Rowan Ashdown/).first()).not.toHaveAttribute('data-dimmed', /.*/);
  await expect(card(/^Iris Vale/).first()).toHaveAttribute('data-dimmed', 'true');
  expect([rowan, iris]).toHaveLength(2);

  await page.getByRole('button', { name: 'Clear highlight' }).click();
  await expect(card(/^Iris Vale/).first()).not.toHaveAttribute('data-dimmed', /.*/);
});

test('is reachable from the command palette and the people list', async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto('/people');
  await page.getByRole('link', { name: 'Manage tags' }).click();
  await expect(page).toHaveURL(/\/tags$/);
  await page.locator('html[data-shell-ready]').waitFor({ state: 'attached' });
  await page.keyboard.press(`${mod}+k`);
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox'),
  ).toBeFocused();
  await page.keyboard.type('manage tags');
  await expect(page.getByRole('option', { name: 'Manage tags' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tags$/);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`tags page has no axe violations in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openTags(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}
