import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { person, send, session, uniqueTreeName } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * Tree checker (#57): a seeded tree with one of each problem, listed with
 * links to the people involved, dismissable and undoable.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

interface Seeded {
  tree: string;
  rowan: string;
  twin: string;
  backwards: string;
}

async function seedChecks(request: APIRequestContext, baseURL: string, label: string) {
  const s = await session(request, baseURL);
  const tree = uniqueTreeName('check', label);
  await send(request, s, 'post', '/api/trees', { name: tree });
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  const add = async (body: ReturnType<typeof person>) =>
    (await send<{ person: { id: string } }>(request, s, 'post', `${base}/people`, body)).person.id;
  const rowan = await add(person('Rowan', 'Ashdown', 'M', '12 MAR 1880', '3 NOV 1950'));
  const twin = await add(person('Rowan', 'Ashdowne', 'M', 'ABT 1881'));
  const backwards = await add(person('Bram', 'Vale', 'M', '1900', '1890'));
  return { tree, rowan, twin, backwards } satisfies Seeded;
}

async function openChecker(page: Page, seeded: Seeded) {
  await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), seeded.tree);
  await page.goto('/checker');
  await expect(page.getByRole('heading', { level: 1, name: 'Tree checker' })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

const toasts = (page: Page) =>
  page.getByRole('region', { name: /Notifications/ }).getByRole('listitem');
const issues = (page: Page) => page.getByRole('list', { name: 'Issues' }).getByRole('listitem');

let seeded: Seeded;
test.beforeEach(async ({ request, baseURL }, testInfo) => {
  seeded = await seedChecks(request, baseURL!, `${testInfo.project.name} ${testInfo.title}`);
});

test('lists duplicates, impossible dates and unsourced people with links', async ({ page }) => {
  await openChecker(page, seeded);
  await expect(page.getByRole('tab', { name: /Possible duplicates/ })).toContainText('1');
  await expect(page.getByRole('tab', { name: /Impossible dates/ })).toContainText('1');
  await expect(page.getByRole('tab', { name: /No sources/ })).toContainText('3');

  await page.getByRole('tab', { name: /Possible duplicates/ }).click();
  const dupe = issues(page).first();
  await expect(dupe).toContainText('Possible duplicate');
  await expect(dupe.getByRole('link', { name: /Rowan Ashdowne/ })).toHaveAttribute(
    'href',
    `/person/${seeded.twin}`,
  );

  await page.getByRole('tab', { name: /Impossible dates/ }).click();
  await expect(issues(page).first()).toContainText('Died in 1890, before birth in 1900');
  await issues(page)
    .first()
    .getByRole('link', { name: /Bram Vale/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/person/${seeded.backwards}$`));
});

test('dismisses an issue, shows it under Dismissed, and undo brings it back', async ({ page }) => {
  await openChecker(page, seeded);
  await page.getByRole('tab', { name: /Impossible dates/ }).click();
  await issues(page).first().getByRole('button', { name: 'Dismiss' }).click();
  await expect(issues(page)).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Impossible dates/ })).toContainText('0');

  await page.getByRole('tab', { name: /Dismissed/ }).click();
  await expect(issues(page).first()).toContainText('Died in 1890, before birth in 1900');

  await page.keyboard.press(`${mod}+z`);
  await expect(toasts(page).filter({ hasText: 'Undid Dismiss check' })).toBeVisible();
  await page.getByRole('tab', { name: /Impossible dates/ }).click();
  await expect(issues(page)).toHaveCount(1);

  // Restore from the Dismissed tab too.
  await issues(page).first().getByRole('button', { name: 'Dismiss' }).click();
  await page.getByRole('tab', { name: /Dismissed/ }).click();
  await issues(page).first().getByRole('button', { name: 'Restore' }).click();
  await expect(issues(page)).toHaveCount(0);
});

test('is reachable from the people list and the command palette', async ({ page }) => {
  await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), seeded.tree);
  await page.goto('/people');
  await page.getByRole('link', { name: 'Check tree' }).click();
  await expect(page).toHaveURL(/\/checker$/);
  await page.goto('/');
  await page.locator('html[data-shell-ready]').waitFor({ state: 'attached' });
  await page.keyboard.press(`${mod}+k`);
  await page.keyboard.type('checker');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/checker$/);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`has no axe violations in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openChecker(page, seeded);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}
