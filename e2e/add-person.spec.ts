import type { Page } from '@playwright/test';
import { createEmptyTree, openTree, seedTree } from './edit-seed';
import { expect, test } from './fixtures';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const toasts = (page: Page) =>
  page.getByRole('region', { name: /Notifications/ }).getByRole('listitem');

/** WebKit only tabs to buttons (the Sex select) with Alt held. */
const tab = (page: Page) =>
  page.keyboard.press(
    page.context().browser()?.browserType().name() === 'webkit' ? 'Alt+Tab' : 'Tab',
  );

/** Fills the Add person form with the keyboard only and saves with Enter. */
async function fillWithKeyboard(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Add person' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Given names' })).toBeFocused();
  await page.keyboard.type('Wren');
  await tab(page);
  await expect(dialog.getByRole('textbox', { name: 'Surname' })).toBeFocused();
  await page.keyboard.type('Ashby');
  await tab(page);
  await expect(dialog.getByRole('combobox', { name: 'Sex' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: 'Female' }).press('Enter');
  await expect(dialog.getByRole('combobox', { name: 'Sex' })).toHaveText(/Female/);
  // The list hands focus back to its trigger once it has closed.
  await expect(dialog.getByRole('combobox', { name: 'Sex' })).toBeFocused();
  await tab(page);
  await expect(dialog.getByRole('textbox', { name: 'Birth date' })).toBeFocused();
  await page.keyboard.type('abt 1902');
  await expect(dialog.getByTestId('date-preview')).toContainText('1902');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
}

test('adds the first person to an empty tree, who becomes home, then undoes and redoes', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const tree = await createEmptyTree(request, baseURL!, `${testInfo.project.name} first`);
  await openTree(page, tree, '/people');
  await expect(page.getByText('No people in this tree yet')).toBeVisible();

  await page.getByRole('button', { name: 'Add person' }).click();
  await fillWithKeyboard(page);

  await expect(h1(page)).toHaveText('Wren Ashby');
  await expect(page).toHaveURL(/\/person\/[0-9A-Z]+$/);
  const personId = page.url().split('/').pop()!;
  const home = await (await request.get(`/api/trees/${encodeURIComponent(tree)}/home`)).json();
  expect(home.personId).toBe(personId);

  // One undo step removes her (and the home person with her) and leaves her page.
  await page.keyboard.press(`${mod}+z`);
  await expect(toasts(page).filter({ hasText: 'Undid Add person: Wren Ashby' })).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(personId));
  await page.goto('/people');
  await expect(page.getByText('No people in this tree yet')).toBeVisible();

  await page.locator('html[data-shell-ready]').waitFor({ state: 'attached' });
  await page.keyboard.press(`Shift+${mod}+z`);
  await expect(toasts(page).filter({ hasText: 'Redid Add person: Wren Ashby' })).toBeVisible();
  await expect(page.getByTestId('people-count')).toHaveText('1 person');
  await expect(page.getByRole('link', { name: 'Wren Ashby' })).toBeVisible();
});

test('adds an unconnected person from the people list header', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seedTree(request, baseURL!, `${testInfo.project.name} header`);
  await openTree(page, seeded.tree, '/people');
  await expect(page.getByTestId('people-count')).toHaveText('5 people');
  await page.getByRole('button', { name: 'Add person' }).click();
  await fillWithKeyboard(page);
  await expect(h1(page)).toHaveText('Wren Ashby');
  // Not attached to anyone, and the existing home person is unchanged.
  await expect(page.getByText('No family recorded')).toBeVisible();
  const home = await (
    await request.get(`/api/trees/${encodeURIComponent(seeded.tree)}/home`)
  ).json();
  expect(home.personId).toBe(seeded.rowan);
});

test('adds a person from the command palette', async ({ page, request, baseURL }, testInfo) => {
  const tree = await createEmptyTree(request, baseURL!, `${testInfo.project.name} palette`);
  await openTree(page, tree, '/people');
  await page.keyboard.press(`${mod}+k`);
  const palette = page.getByRole('dialog', { name: /command palette/i });
  await expect(palette).toBeVisible();
  await page.keyboard.type('add person');
  await expect(palette.getByRole('option', { name: 'Add person' })).toBeVisible();
  await page.keyboard.press('Enter');
  await fillWithKeyboard(page);
  await expect(h1(page)).toHaveText('Wren Ashby');
});

test('opening an empty tree from the start page leads to Add person', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const tree = await createEmptyTree(request, baseURL!, `${testInfo.project.name} start`);
  await openTree(page, tree, '/');
  await page
    .getByRole('navigation', { name: 'Recent trees' })
    .getByRole('button', { name: tree })
    .click();
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.getByText('No people in this tree yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add person' }).click();
  await fillWithKeyboard(page);
  await expect(h1(page)).toHaveText('Wren Ashby');
});

test('a tree made with New tree opens on its people list, ready to add someone', async ({
  page,
}, testInfo) => {
  const name = `New ${Date.now()} ${testInfo.project.name}`;
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: /Tree:/ }).click();
  await page.getByRole('menuitem', { name: 'New tree…' }).click();
  const create = page.getByRole('dialog', { name: 'New tree' });
  await create.getByLabel('Tree name').fill(name);
  await create.getByRole('button', { name: 'Create tree' }).click();
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.getByRole('button', { name: 'Add person' })).toBeVisible();
});

test('names are capped at the server limit, and a refused field gets a plain message', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const tree = await createEmptyTree(request, baseURL!, `${testInfo.project.name} limits`);
  await openTree(page, tree, '/people');
  await page.getByRole('button', { name: 'Add person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add person' });
  const given = dialog.getByRole('textbox', { name: 'Given names' });
  await given.fill('A'.repeat(250));
  await expect(given).toHaveValue('A'.repeat(200));
  await expect(dialog.getByRole('textbox', { name: 'Surname' })).toHaveAttribute(
    'maxlength',
    '200',
  );

  // Should the server still refuse a field, the form says so in words, on that field.
  await page.route('**/people', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'validation_failed',
              message:
                'body/names/0/given must NOT have more than 200 characters, body/names/0/given must be null',
            },
          }),
        })
      : route.fallback(),
  );
  await dialog.getByRole('button', { name: 'Add person' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(/Given names can be at most 200 characters\./);
  await expect(dialog.getByRole('alert')).not.toContainText('body/');
  await expect(given).toHaveAccessibleDescription(/at most 200 characters/);
});

test('Cmd/Ctrl-K, Add person, Escape returns focus to where it was', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const tree = await createEmptyTree(request, baseURL!, `${testInfo.project.name} focus`);
  await openTree(page, tree, '/people');
  const people = page.getByRole('banner').getByRole('link', { name: 'People' });
  await people.focus();
  await page.keyboard.press(`${mod}+k`);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('add person');
  await expect(palette.getByRole('option', { name: 'Add person' })).toBeVisible();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add person' });
  await expect(dialog.getByRole('textbox', { name: 'Given names' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(people).toBeFocused();
});
