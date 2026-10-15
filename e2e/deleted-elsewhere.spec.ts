import type { Page } from '@playwright/test';
import { openSeeded, seedTree, send, session, type SeededTree } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * A person (or one of their names) deleted in another tab, or by undo, while
 * this tab edits them (#189): one plain message without internal ids, no
 * retry that cannot succeed, and the page moves to a relative or the people
 * list instead of the import screen. Deletes go through the API, which this
 * tab does not hear about, so the save is what finds out.
 */

let seeded: SeededTree;

test.beforeEach(async ({ request, baseURL }, testInfo) => {
  seeded = await seedTree(request, baseURL!, `${testInfo.project.name} ${testInfo.title}`);
});

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const toasts = (page: Page) =>
  page.getByRole('region', { name: /Notifications/ }).getByRole('listitem');
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;

test('saving an edit to a deleted person explains it', async ({ page, request, baseURL }) => {
  await openSeeded(page, seeded);
  await page.getByRole('button', { name: 'Edit person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Ghost');

  // Deleted where this tab cannot hear it (another device, a script).
  const { headers } = await session(request, baseURL!);
  const res = await request.delete(
    `/api/trees/${encodeURIComponent(seeded.tree)}/people/${seeded.rowan}`,
    { headers },
  );
  expect(res.ok()).toBe(true);

  await dialog.getByRole('button', { name: 'Save' }).click();
  const message = toasts(page).filter({
    hasText: 'Rowan Ashdown was deleted (in another window or by undo)',
  });
  await expect(message).toBeVisible();
  await expect(message).toContainText("Your changes couldn't be saved");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  for (const text of await toasts(page).allInnerTexts()) expect(text).not.toMatch(ULID);
  await expect(toasts(page)).toHaveCount(1);

  // The nearest relative: a parent.
  await expect(page).toHaveURL(new RegExp(`/person/${seeded.edmund}$`));
  await expect(h1(page)).toHaveText('Edmund Ashdown');
});

test('saving over a name deleted elsewhere explains it and stays', async ({
  page,
  request,
  baseURL,
}) => {
  const s = await session(request, baseURL!);
  const base = `/api/trees/${encodeURIComponent(seeded.tree)}`;
  const { name } = await send<{ name: { id: string } }>(
    request,
    s,
    'post',
    `${base}/people/${seeded.rowan}/names`,
    { given: 'Ro', surname: 'Ashe', type: 'aka' },
  );
  await openSeeded(page, seeded);
  await page.getByRole('button', { name: 'Edit person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await dialog
    .getByRole('group', { name: 'Name 2' })
    .getByRole('textbox', { name: 'Given names' })
    .fill('Robin');
  const res = await request.delete(`${base}/names/${name.id}`, { headers: s.headers });
  expect(res.ok()).toBe(true);

  await dialog.getByRole('button', { name: 'Save' }).click();
  const message = toasts(page).filter({ hasText: 'deleted (in another window or by undo)' });
  await expect(message).toBeVisible();
  await expect(message).toContainText("your changes couldn't be saved");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  for (const text of await toasts(page).allInnerTexts()) expect(text).not.toMatch(ULID);
  await expect(toasts(page)).toHaveCount(1);
  await expect(h1(page)).toHaveText('Rowan Ashdown');
});

test('a deleted person with no relatives leads to the people list', async ({
  page,
  request,
  baseURL,
}) => {
  await openSeeded(page, seeded, seeded.wendell);
  await page.getByRole('button', { name: 'Edit person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Ghost');
  const { headers } = await session(request, baseURL!);
  await request.delete(`/api/trees/${encodeURIComponent(seeded.tree)}/people/${seeded.wendell}`, {
    headers,
  });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(
    toasts(page).filter({ hasText: 'Wendell Quarrier was deleted (in another window or by undo)' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/people$/);
});
