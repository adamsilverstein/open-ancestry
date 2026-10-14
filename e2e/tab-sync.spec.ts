import type { Page } from '@playwright/test';
import { openSeeded, seedTree, send, session, type SeededTree } from './edit-seed';
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

test('an edit, undo or redo in one tab shows up in the other within a second', async ({ page }) => {
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

test('a save made from stale data is refused, not mixed in', async ({ page, request, baseURL }) => {
  await openSeeded(page, seeded);
  await expect(h1(page)).toHaveText('Rowan Ashdown');
  await page.getByRole('button', { name: 'Edit person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await dialog.getByRole('textbox', { name: 'Surname' }).first().fill('Ashby');

  // Meanwhile something this tab never hears about renames Rowan (a script, another device).
  const s = await session(request, baseURL!);
  const base = `/api/trees/${encodeURIComponent(seeded.tree)}`;
  const detail = await (await request.get(`${base}/people/${seeded.rowan}`)).json();
  await send(request, s, 'post', `${base}/batch`, {
    label: 'Elsewhere',
    operations: [{ op: 'name.update', id: detail.names[0].id, name: { given: 'Roland' } }],
  });

  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByText(/changed in another window \(or by undo\) after you opened it/),
  ).toBeVisible();
  // The page shows what the server has, never "Rowan Ashby" or "Roland Ashby".
  await expect(h1(page)).toHaveText('Roland Ashdown');
  const after = await (await request.get(`${base}/people/${seeded.rowan}`)).json();
  expect(after.names[0]).toMatchObject({ given: 'Roland', surname: 'Ashdown' });
});
