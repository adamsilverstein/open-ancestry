import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openTree, person, send, session, uniqueTreeName } from './edit-seed';
import { sampleTree, setHome } from './sample-tree';

/*
 * Issue #278: dates read the same everywhere. The people list formats stored
 * dates, and tree cards keep their qualifiers ("Uncertainty is visible").
 * Issue #298: dual dates sort as Old Style days, like their GEDCOM 7 export.
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

test('dual dates sort as their Old Style (Julian) day (#298)', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const s = await session(request, baseURL!);
  const tree = uniqueTreeName('dual', testInfo.project.name);
  await send(request, s, 'post', '/api/trees', { name: tree });
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  // Old Style 29 Feb 1752 is New Style 11 Mar 1752, and 8 Mar is 19 Mar.
  const { person: oldStyle } = await send<{ person: { id: string } }>(
    request,
    s,
    'post',
    `${base}/people`,
    {
      sex: 'F',
      names: [{ given: 'Wynn', surname: 'Hollis' }],
      events: [
        { type: 'BIRT', date_text: '29 FEB 1751/52' },
        { type: 'CHR', date_text: '8 MAR 1751/52' },
        { type: 'RESI', date_text: '15 MAR 1752' },
      ],
    },
  );
  await send(request, s, 'post', `${base}/people`, person('Tamsin', 'Hollis', 'F', '5 MAR 1752'));

  await openTree(page, tree, '/people?sort=birth');
  const table = page.getByRole('table', { name: 'People' });
  const births = table.locator('[role="row"][aria-rowindex] [data-column="birth"]');
  await expect(births).toHaveText(['5 Mar 1752', '29 Feb 1751/52']);

  await page.goto(`/person/${oldStyle.id}`);
  const titles = page
    .getByRole('region', { name: 'Timeline', exact: true })
    .getByRole('listitem')
    .locator('[data-title]');
  await expect(titles).toHaveText(['Birth', 'Residence', 'Christening']);
});
