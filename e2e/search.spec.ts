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

test('the first Cmd/Ctrl-K keeps a surname typed before the palette loads (#113)', async ({
  page,
}) => {
  await page.route(/\/assets\/ShellCommandPalette-[^/]+\.js$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await open(page);
  await page.keyboard.press(`${modKey}+k`);
  await page.keyboard.type('thackeray');
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog.getByRole('combobox')).toHaveValue('thackeray');
  await expect(people(dialog).first()).toContainText('Thackeray');
});

test('Enter typed before the palette loads opens the first result once it arrives', async ({
  page,
}) => {
  await page.route(/\/assets\/ShellCommandPalette-[^/]+\.js$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await open(page);
  await page.keyboard.press(`${modKey}+k`);
  await page.keyboard.type('wren thackeray');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/person\//);
  await expect(page.getByRole('heading', { level: 1, name: /Wren/ })).toBeVisible();
});

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
  await expect(page).toHaveURL(new RegExp(`/person/${wren}(\\?tree=[^&]*)?$`));
  await expect(dialog).toBeHidden();
});

test('announces the result count, and focuses the new page heading after Enter (#200)', async ({
  page,
}) => {
  await open(page, '/people');
  const dialog = await search(page, 'wren thackeray');
  await expect(people(dialog).first()).toContainText('Wren Thackeray');
  // A polite status inside the palette says how many results there are once they settle.
  await expect(dialog.getByRole('status')).toHaveText(/^\d+ (person|people)/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/person\//);
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
});

test('opening the people list and the tree from the palette focuses their heading (#200)', async ({
  page,
}) => {
  await open(page, '/people');
  let dialog = await search(page, 'wren thackeray');
  await expect(people(dialog).first()).toContainText('Wren Thackeray');
  // Shift+Enter shows the person in the tree view.
  await page.keyboard.press('Shift+Enter');
  await expect(page).toHaveURL(/\/tree\//);
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();

  dialog = await search(page, 'people list');
  await expect(dialog.getByRole('option', { name: 'Open people list' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeFocused();
});

test('says when nothing matches, and Escape still returns focus to the opener', async ({
  page,
}) => {
  await open(page, '/people');
  const opener = page.getByRole('banner').getByRole('button', { name: /^Find/ });
  // A mouse click: WebKit does not focus the clicked button, so the palette
  // falls back to the last control pressed (lib/returnFocus).
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await dialog.getByRole('combobox').fill('zzzzqqqq');
  await expect(dialog.getByRole('status')).toHaveText('No results');
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
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
  // Let the tree finish loading first. The client-side navigation to it can still be
  // committing when page.goto starts a new document, and WebKit then reports the
  // goto as interrupted by a navigation to /tree/<id> (seen in CI).
  await expect(page.getByRole('application', { name: /^Family tree/ })).toHaveAttribute(
    'aria-busy',
    'false',
  );

  await page.goto('/');
  await expect(page.locator('html[data-shell-ready]')).toBeAttached();
  dialog = await search(page, 'ezra thackery');
  await expect(people(dialog).first()).toContainText('Ezra Thackery');
  await page.keyboard.press('Alt+Enter');
  await expect(page).toHaveURL(new RegExp(`/tree/${ezra}$`));
});

test('Enter right after typing waits for this query, never the previous one', async ({
  page,
  request,
}) => {
  const ezra = await personId(request, 'ezra thackery');
  await open(page);
  const dialog = await search(page, 'mabyn');
  await expect(people(dialog).first()).toContainText('Mabyn Thackeray');
  await dialog.getByRole('combobox').fill('ezra');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/person/${ezra}(\\?tree=[^&]*)?$`));

  const second = await search(page, 'mabyn');
  await expect(people(second).first()).toContainText('Mabyn Thackeray');
  await second.getByRole('combobox').fill('ezra thackery');
  await page.keyboard.press('Shift+Enter');
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
  await expect(page).toHaveURL(new RegExp(`/person/${ezra}(\\?tree=[^&]*)?$`));
});

test('search answers within the budget on a 10k tree', async ({ request }) => {
  // Server time (Server-Timing), so parallel workers and HTTP overhead do not
  // count; design.md section 7 budgets search at 50ms.
  const serverMs = async (q: string) => {
    const res = await request.get(`${base}/search?q=${encodeURIComponent(q)}`);
    expect(res.ok()).toBe(true);
    return Number(/dur=([\d.]+)/.exec(res.headers()['server-timing'] ?? '')?.[1]);
  };
  // Judge warm queries by their median: the first run of a query reads cold
  // pages, and one sample on a loaded machine can spike far past the budget
  // (171ms seen at load ~50; warm medians stay near 1-3ms).
  for (const q of ['wren', 'thackeray 1850', 'ash', 'kestrel cove', 'vail']) {
    await serverMs(q);
    const runs = [
      await serverMs(q),
      await serverMs(q),
      await serverMs(q),
      await serverMs(q),
      await serverMs(q),
    ];
    const median = runs.sort((a, b) => a - b)[2]!;
    expect(median, `${q}: ${runs.join(', ')}ms`).toBeLessThan(50);
  }
});
