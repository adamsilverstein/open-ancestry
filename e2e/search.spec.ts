import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SEARCH_TREE } from './search-fixture';

/*
 * Issue #9: the command palette searches people in the open tree (names in
 * every variant, places, years, sounds-alike surnames), is keyboard driven,
 * and jumps to the person page or the tree.
 */

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
const base = `/api/trees/${encodeURIComponent(SEARCH_TREE)}`;

async function personId(request: APIRequestContext, q: string): Promise<string> {
  const { items } = await (
    await request.get(`${base}/search?q=${encodeURIComponent(q)}&limit=1`)
  ).json();
  return items[0].person.id as string;
}

/** Opens the app on `path` with the search fixture as the current tree. */
async function open(page: Page, path = '/') {
  await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), SEARCH_TREE);
  await page.goto(path);
  await expect(page.locator('html[data-shell-ready]')).toBeAttached();
}

async function search(page: Page, text: string) {
  await page.keyboard.press(`${modKey}+k`);
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox').fill(text);
  return dialog;
}

const people = (dialog: ReturnType<Page['getByRole']>) =>
  dialog.getByRole('group', { name: 'People' }).getByRole('option');

test('finds a person by name and opens the person page with Enter', async ({ page, request }) => {
  const wren = await personId(request, 'wren thackeray');
  await open(page);
  const dialog = await search(page, 'wren thackeray');
  const first = people(dialog).first();
  await expect(first).toContainText('Wren Thackeray');
  await expect(first).toContainText('1850–1921');
  await expect(first).toContainText('Kestrel Cove, Saltmarsh');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/person/${wren}$`));
  await expect(dialog).toBeHidden();
});

test('arrow keys move through results and Shift+Enter or Alt+Enter focus the tree', async ({
  page,
  request,
}) => {
  const ezra = await personId(request, 'ezra thackery');
  await open(page);
  let dialog = await search(page, 'thackery');
  // Exact match first, then sounds-alike Thackerays.
  await expect(people(dialog).first()).toContainText('Ezra Thackery');
  await expect(people(dialog)).toHaveCount(3);
  await page.keyboard.press('ArrowDown');
  await expect(people(dialog).nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Shift+Enter');
  await expect(page).toHaveURL(new RegExp(`/tree/${ezra}$`));

  await page.goto('/');
  await expect(page.locator('html[data-shell-ready]')).toBeAttached();
  dialog = await search(page, 'ezra thackery');
  await expect(people(dialog).first()).toContainText('Ezra Thackery');
  await page.keyboard.press('Alt+Enter');
  await expect(page).toHaveURL(new RegExp(`/tree/${ezra}$`));
});

test('matches married names, prefixes, places and approximate years', async ({ page }) => {
  await open(page);
  const dialog = await search(page, 'abernathy');
  await expect(people(dialog).first()).toContainText('Wren Thackeray');
  await dialog.getByRole('combobox').fill('wren thack');
  await expect(people(dialog).first()).toContainText('Wren Thackeray');
  await dialog.getByRole('combobox').fill('thackeray 1851');
  await expect(people(dialog).first()).toContainText('Wren Thackeray');
  await dialog.getByRole('combobox').fill('kestrel cove');
  await expect(people(dialog)).toHaveCount(2);
  await dialog.getByRole('combobox').fill('zzqx');
  await expect(people(dialog)).toHaveCount(0);
  await expect(dialog.getByText('No results')).toBeVisible();
});

test('actions still filter alongside people', async ({ page }) => {
  await open(page);
  const dialog = await search(page, 'people');
  await dialog.getByRole('option', { name: /Open people list/ }).click();
  await expect(page).toHaveURL(/\/people$/);
});

test('on the tree, Find focuses the tree and Alt+Enter opens the person page', async ({
  page,
  request,
}) => {
  const wren = await personId(request, 'wren thackeray');
  const ezra = await personId(request, 'ezra thackery');
  await open(page, `/tree/${ezra}`);
  await page.getByRole('banner').getByRole('button', { name: /^Find/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await dialog.getByRole('combobox').fill('wren thackeray');
  await expect(people(dialog).first()).toContainText('Wren Thackeray');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/tree/${wren}$`));

  await page.keyboard.press(`${modKey}+k`);
  await dialog.getByRole('combobox').fill('ezra thackery');
  await expect(people(dialog).first()).toContainText('Ezra Thackery');
  await page.keyboard.press('Alt+Enter');
  await expect(page).toHaveURL(new RegExp(`/person/${ezra}$`));
});

test('search answers within the budget on a 10k tree', async ({ request }) => {
  // Warm the tree, then time the API the palette calls (design.md section 7: < 50ms).
  await request.get(`${base}/search?q=a`);
  const timings: number[] = [];
  for (const q of ['wren', 'thackeray 1850', 'ash', 'kestrel cove', 'vail']) {
    const start = performance.now();
    expect((await request.get(`${base}/search?q=${encodeURIComponent(q)}`)).ok()).toBe(true);
    timings.push(performance.now() - start);
  }
  expect(Math.max(...timings)).toBeLessThan(50);
});
