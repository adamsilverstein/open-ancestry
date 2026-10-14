import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { BIG_TREE, BIG_TREE_PEOPLE, SEARCH_TREE, SEARCH_TREE_PEOPLE } from './search-fixture';

/*
 * Issue #9: the people list is sortable by surname, given name, birth and
 * death, filters by tag, living and sex, and stays virtualized at 100k rows.
 */

async function open(page: Page, tree: string, path = '/people') {
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
}

const table = (page: Page) => page.getByRole('table', { name: 'People' });
const bodyRows = (page: Page) =>
  table(page).locator('[role="row"][aria-rowindex]:not([aria-rowindex="1"])');

test('lists everyone with a count, rendering only the visible rows', async ({ page }) => {
  await open(page, SEARCH_TREE);
  await expect(
    page.getByText(`${SEARCH_TREE_PEOPLE.toLocaleString('en-US')} people`),
  ).toBeVisible();
  await expect(table(page)).toHaveAttribute('aria-rowcount', String(SEARCH_TREE_PEOPLE + 1));
  await expect(bodyRows(page).first()).toBeVisible();
  expect(await bodyRows(page).count()).toBeLessThan(80);
});

test('sorts by each column from the headers', async ({ page }) => {
  await open(page, SEARCH_TREE);
  const surname = page.getByRole('columnheader', { name: /Surname/ });
  await expect(surname).toHaveAttribute('aria-sort', 'ascending');
  await expect(bodyRows(page).first().getByRole('cell').nth(1)).toHaveText('Ashgrove');

  await surname.getByRole('button').click();
  await expect(surname).toHaveAttribute('aria-sort', 'descending');
  await expect(page).toHaveURL(/dir=desc/);
  await expect(bodyRows(page).first().getByRole('cell').nth(1)).toHaveText('Yarrow');

  const birth = page.getByRole('columnheader', { name: 'Birth', exact: true });
  await birth.getByRole('button').click();
  await expect(birth).toHaveAttribute('aria-sort', 'ascending');
  await expect(surname).not.toHaveAttribute('aria-sort', /ascending|descending/);
  await expect(page).toHaveURL(/sort=birth/);
  const birthYears = async () =>
    (await bodyRows(page).locator('[data-column="birth"]').allTextContents())
      .map((y) => Number(/\d{4}/.exec(y)?.[0]))
      .filter(Boolean);
  await expect.poll(async () => (await birthYears()).length).toBeGreaterThan(5);
  const numbers = await birthYears();
  expect(numbers).toEqual([...numbers].sort((a, b) => a - b));

  for (const name of ['Given names', 'Death']) {
    const header = page.getByRole('columnheader', { name, exact: true });
    await header.getByRole('button').click();
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
  }
});

test('filters by sex, living status and tag, kept in the URL', async ({ page }) => {
  await open(page, SEARCH_TREE);
  const count = page.getByTestId('people-count');
  await expect(count).toHaveText(`${SEARCH_TREE_PEOPLE.toLocaleString('en-US')} people`);

  await page.getByRole('combobox', { name: 'Tag' }).click();
  await page.getByRole('option', { name: 'Brick wall' }).click();
  await expect(count).toHaveText('1 person');
  await expect(bodyRows(page)).toHaveCount(1);
  await expect(bodyRows(page).first()).toContainText('Wren');

  await page.getByRole('combobox', { name: 'Living' }).click();
  await page.getByRole('option', { name: 'Living', exact: true }).click();
  await expect(count).toHaveText('0 people');
  await expect(page.getByText('No people match these filters')).toBeVisible();
  await page.getByRole('combobox', { name: 'Living' }).click();
  await page.getByRole('option', { name: 'Deceased' }).click();
  await expect(count).toHaveText('1 person');

  await page.getByRole('combobox', { name: 'Sex' }).click();
  await page.getByRole('option', { name: 'Male', exact: true }).click();
  await expect(count).toHaveText('0 people');
  await expect(page).toHaveURL(/sex=M/);
  await expect(page).toHaveURL(/living=deceased/);
  await expect(page).toHaveURL(/tag=/);

  // Reloading keeps the filters.
  await page.reload();
  await expect(count).toHaveText('0 people');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(count).toHaveText(`${SEARCH_TREE_PEOPLE.toLocaleString('en-US')} people`);
});

test('the top bar links to the people list', async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), SEARCH_TREE);
  await page.goto('/');
  await page.getByRole('banner').getByRole('link', { name: 'People' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('link', { name: 'People' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('opens a person from the list', async ({ page }) => {
  await open(page, SEARCH_TREE, '/people?sort=surname');
  const link = bodyRows(page).first().getByRole('link');
  await expect(link).toHaveAccessibleName(/Ashgrove/);
  await link.click();
  await expect(page).toHaveURL(/\/person\/[0-9A-Z]{26}(\?tree=[^&]*)?$/);
});

test('stays virtualized and scrolls to the end of a 100k tree', async ({ page }) => {
  await open(page, BIG_TREE);
  await expect(table(page)).toHaveAttribute('aria-rowcount', String(BIG_TREE_PEOPLE + 1));
  await expect(bodyRows(page).first()).toBeVisible();
  const scroller = page.getByTestId('people-scroller');
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const last = table(page).locator(`[aria-rowindex="${BIG_TREE_PEOPLE + 1}"]`);
  await expect(last).toBeVisible();
  await expect(last.getByRole('link')).not.toHaveText('');
  expect(await bodyRows(page).count()).toBeLessThan(80);
  // Jump to the middle: the page for that range loads on demand.
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
  await expect(
    bodyRows(page)
      .filter({ has: page.getByRole('link') })
      .first(),
  ).toBeVisible();
});

test('has no accessibility violations', async ({ page }) => {
  await open(page, SEARCH_TREE);
  await expect(bodyRows(page).first()).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('explains when no tree is open', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('oa-tree', 'Nope'));
  await page.route('**/api/trees', (route) => route.fulfill({ json: { trees: [] } }));
  await page.goto('/people');
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
  await expect(page.getByText('No tree is open')).toBeVisible();
});
