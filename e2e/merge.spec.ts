import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { person, send, session, uniqueTreeName } from './edit-seed';
import { expect, test } from './fixtures';

/* Merging duplicates (#57): compare side by side, choose facts, merge, undo. */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

let tree: string;
let rowan: string;
let twin: string;

test.beforeEach(async ({ request, baseURL }, testInfo) => {
  const s = await session(request, baseURL!);
  tree = uniqueTreeName('merge', `${testInfo.project.name} ${testInfo.title}`);
  await send(request, s, 'post', '/api/trees', { name: tree });
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  const add = async (body: ReturnType<typeof person>) =>
    (await send<{ person: { id: string } }>(request, s, 'post', `${base}/people`, body)).person.id;
  rowan = await add(person('Rowan', 'Ashdown', 'M', '12 MAR 1880', '3 NOV 1950'));
  twin = await add(person('Rowan', 'Ashdowne', 'M', 'ABT 1881'));
  await send(request, s, 'post', `${base}/people/${twin}/spouses`, {
    person: person('Iris', 'Vale', 'F', '1885'),
  });
});

async function openCompare(page: Page) {
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto('/checker');
  await page.locator('html[data-shell-ready]').waitFor({ state: 'attached' });
  await page.getByRole('tab', { name: /Possible duplicates/ }).click();
  await page.getByRole('link', { name: 'Compare and merge' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Merge duplicates' })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test('compares two records, merges with the chosen facts, and undoes', async ({ page }) => {
  await openCompare(page);
  const table = page.getByRole('table', { name: 'Compare records' });
  await expect(table.getByRole('row', { name: /Birth/ })).toContainText('12 Mar 1880');
  await expect(table.getByRole('row', { name: /Birth/ })).toContainText('abt. 1881');
  await expect(table.getByRole('row', { name: /Spouses/ })).toContainText('Iris Vale');

  // Keep the left record but take the right one's birth.
  await table.getByRole('radio', { name: /Birth from Rowan Ashdowne/ }).check();
  await page.getByRole('button', { name: 'Merge' }).click();
  const confirm = page.getByRole('alertdialog', {
    name: /Merge Rowan Ashdowne into Rowan Ashdown/,
  });
  await confirm.getByRole('button', { name: 'Merge' }).click();

  await expect(page).toHaveURL(new RegExp(`/person/(${rowan}|${twin})$`));
  const id = new URL(page.url()).pathname.split('/').pop()!;
  const timeline = page.getByRole('region', { name: 'Timeline', exact: true });
  const births = timeline
    .getByRole('listitem')
    .filter({ has: page.locator('[data-title]', { hasText: /^Birth$/ }) });
  await expect(births.first()).toContainText('abt. 1881');
  await expect(births.nth(1)).toContainText('alternate');
  await expect(page.getByRole('region', { name: 'Relationships', exact: true })).toContainText(
    'Iris Vale',
  );

  await page.keyboard.press(`${mod}+z`);
  await expect(
    page
      .getByRole('region', { name: /Notifications/ })
      .getByRole('listitem')
      .filter({ hasText: 'Undid Merge' }),
  ).toBeVisible();
  await expect(births).toHaveCount(1);
  expect([rowan, twin]).toContain(id);
});

test('can swap which record is kept and take its name', async ({ page }) => {
  await openCompare(page);
  await page.getByRole('button', { name: 'Swap sides' }).click();
  const table = page.getByRole('table', { name: 'Compare records' });
  await expect(table.getByRole('columnheader').nth(1)).toContainText('Rowan Ashdowne');
  await table.getByRole('radio', { name: /Name from Rowan Ashdown$/ }).check();
  await page.getByRole('button', { name: 'Merge' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Merge' }).click();
  await expect(page).toHaveURL(new RegExp(`/person/${twin}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rowan Ashdown');
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`merge page has no axe violations in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openCompare(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}
