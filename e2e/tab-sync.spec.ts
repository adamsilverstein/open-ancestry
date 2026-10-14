import type { Page } from '@playwright/test';
import { openSeeded, seedTree, type SeededTree } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * Two tabs on one tree (#188): every edit, undo or redo in one tab refreshes
 * the other, so neither shows or saves data the server no longer has.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

let seeded: SeededTree;

test.beforeEach(async ({ request, baseURL }, testInfo) => {
  seeded = await seedTree(request, baseURL!, `${testInfo.project.name} ${testInfo.title}`);
});

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });

async function rename(page: Page, given: string) {
  await page.getByRole('button', { name: 'Edit person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await dialog.getByRole('textbox', { name: 'Given names' }).first().fill(given);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

test('an edit, undo or redo in one tab shows up in the other within a second', async ({
  page,
}) => {
  const a = page;
  const b = await page.context().newPage();
  await openSeeded(a, seeded);
  await openSeeded(b, seeded);
  await expect(h1(b)).toHaveText('Rowan Ashdown');

  await rename(a, 'Roland');
  await expect(h1(a)).toHaveText('Roland Ashdown');
  await expect(h1(b)).toHaveText('Roland Ashdown', { timeout: 1000 });

  // B undoes A's edit: the server is tree-wide, so A must follow.
  await b.locator('body').click({ position: { x: 1, y: 1 } });
  await b.keyboard.press(`${mod}+z`);
  await expect(h1(b)).toHaveText('Rowan Ashdown');
  await expect(h1(a)).toHaveText('Rowan Ashdown', { timeout: 1000 });

  await b.keyboard.press(`Shift+${mod}+z`);
  await expect(h1(a)).toHaveText('Roland Ashdown', { timeout: 1000 });
});
