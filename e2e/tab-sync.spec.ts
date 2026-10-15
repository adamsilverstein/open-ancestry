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
const staleToast = (page: Page) =>
  page
    .getByRole('region', { name: /Notifications/ })
    .getByRole('listitem')
    .filter({ hasText: /changed in another window \(or by undo\) after you opened it/ });

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
  // Padding only: not an edit, so on reload it must not undo the rename made elsewhere.
  await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Rowan  ');

  // Meanwhile something this tab never hears about renames Rowan (a script, another device).
  const s = await session(request, baseURL!);
  const base = `/api/trees/${encodeURIComponent(seeded.tree)}`;
  const detail = await (await request.get(`${base}/people/${seeded.rowan}`)).json();
  await send(request, s, 'post', `${base}/batch`, {
    label: 'Elsewhere',
    operations: [{ op: 'name.update', id: detail.names[0].id, name: { given: 'Roland' } }],
  });

  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(staleToast(page)).toBeVisible();
  // The page shows what the server has, never "Rowan Ashby" or "Roland Ashby".
  await expect(h1(page)).toHaveText('Roland Ashdown');
  const after = await (await request.get(`${base}/people/${seeded.rowan}`)).json();
  expect(after.names[0]).toMatchObject({ given: 'Roland', surname: 'Ashdown' });

  // The form stays open with the typed edit and offers to reload: the latest
  // given name, with the surname the user changed kept.
  await expect(dialog.getByRole('alert')).toContainText('changed in another window (or by undo)');
  await dialog.getByRole('button', { name: 'Reload form' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Given names' }).first()).toHaveValue('Roland');
  await expect(dialog.getByRole('textbox', { name: 'Surname' }).first()).toHaveValue('Ashby');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('status')).toContainText('your changes are kept');

  // Both sides change the given name: the form keeps the user's and marks it.
  await send(request, s, 'post', `${base}/batch`, {
    label: 'Elsewhere again',
    operations: [{ op: 'name.update', id: detail.names[0].id, name: { given: 'Rolf' } }],
  });
  await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Robin');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.getByRole('button', { name: 'Reload form' }).click();
  const given = dialog.getByRole('textbox', { name: 'Given names' }).first();
  await expect(given).toHaveValue('Robin');
  await expect(given).toHaveAccessibleDescription(/Also changed elsewhere, to “Rolf”/);
  await expect(dialog.getByRole('status')).toContainText('One field was also changed elsewhere');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(h1(page)).toHaveText('Robin Ashby');
});

test('an open form does not save over an undo from another tab', async ({ page }) => {
  const a = page;
  const b = await page.context().newPage();
  await openSeeded(a, seeded);
  await openSeeded(b, seeded);
  await rename(a, 'Roland');
  await expect(h1(b)).toHaveText('Roland Ashdown');

  await a.getByRole('button', { name: 'Edit person' }).click();
  const dialog = a.getByRole('dialog', { name: 'Edit person' });
  await dialog.getByRole('textbox', { name: 'Surname' }).first().fill('Ashby');

  await b.locator('body').click({ position: { x: 1, y: 1 } });
  await b.keyboard.press(`${mod}+z`);
  await expect(h1(b)).toHaveText('Rowan Ashdown');

  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(staleToast(a)).toBeVisible();
  await expect(h1(a)).toHaveText('Rowan Ashdown');
  await expect(h1(b)).toHaveText('Rowan Ashdown');
  // Still open, with "Ashby" typed in; reloading shows the undone given name.
  await dialog.getByRole('button', { name: 'Reload form' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Given names' }).first()).toHaveValue('Rowan');
  await expect(dialog.getByRole('textbox', { name: 'Surname' }).first()).toHaveValue('Ashby');
});
