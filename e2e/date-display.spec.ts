import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { sampleTree, setHome } from './sample-tree';

/*
 * Issue #278: dates read the same everywhere. The people list formats stored
 * dates, and tree cards keep their qualifiers ("Uncertainty is visible").
 */

async function openSample(page: Page, path: (id: (name: string) => string) => string) {
  const tree = await sampleTree();
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree.name);
  await page.goto(path(tree.id));
}

test('the people list shows dates in the app’s format', async ({ page }) => {
  await openSample(page, () => '/people');
  const table = page.getByRole('table', { name: 'People' });
  const row = (name: string) =>
    table.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
  const cell = (name: string, column: 'birth' | 'death') =>
    row(name).locator(`[data-column="${column}"]`);
  await expect(cell('Clementine Ashgrove', 'birth')).toHaveText('bet. 1870 and 1872');
  await expect(cell('Clementine Ashgrove', 'death')).toHaveText('aft. 1950');
  await expect(cell('Thaddeus Ashgrove', 'birth')).toHaveText('abt. 1842');
  await expect(cell('Thaddeus Ashgrove', 'death')).toHaveText('4 Nov 1911');
  await expect(cell('Mercy Bellweather', 'death')).toHaveText('bef. 1920');
  await expect(cell('Ezra Corran', 'birth')).toHaveText('cal. 1840');
  await expect(cell('Thomas Ashgrove', 'birth')).toHaveText('28 May 1960');
});

test('tree cards keep date qualifiers in lifespans', async ({ page }) => {
  await setHome(page, 'Thaddeus Ashgrove');
  await openSample(page, (id) => `/tree/${id('Thaddeus Ashgrove')}`);
  const canvas = page.getByRole('application', { name: /^Family tree/ });
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  const card = (name: string) =>
    canvas.getByRole('button', { name: new RegExp(`^${name},`) }).first();
  for (const [name, lifespan] of [
    ['Thaddeus Ashgrove', 'abt. 1842–1911'],
    ['Mercy Bellweather', '1846–bef. 1920'],
    // Born "BET 1870 AND 1872": a range reads as about its middle year.
    ['Clementine Ashgrove', 'abt. 1871–aft. 1950'],
  ]) {
    await expect(card(name!)).toContainText(lifespan!);
  }
});
