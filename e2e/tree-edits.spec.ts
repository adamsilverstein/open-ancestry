import type { APIRequestContext, Page } from '@playwright/test';
import { seedTree, type SeededTree } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * The tree view follows edits, undo and redo made while it is open: its
 * neighborhood cache drops what the server no longer has (#80).
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

let seeded: SeededTree;
test.beforeEach(async ({ request, baseURL }, testInfo) => {
  seeded = await seedTree(request, baseURL!, `${testInfo.project.name} ${testInfo.title}`);
});

async function post(request: APIRequestContext, baseURL: string, path: string, data: unknown) {
  const { token } = (await (await request.get('/api/session')).json()) as { token: string };
  const res = await request.post(path, { headers: { origin: baseURL, 'x-oa-token': token }, data });
  expect(res.ok(), await res.text()).toBe(true);
}

const canvas = (page: Page) => page.getByRole('application', { name: /^Family tree/ });
const card = (page: Page, name: string) =>
  canvas(page).getByRole('button', { name: new RegExp(`^${name},`) });

async function openTree(page: Page) {
  await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), seeded.tree);
  await page.goto(`/tree/${seeded.rowan}?tree=${encodeURIComponent(seeded.tree)}`);
  await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
}

const base = () => `/api/trees/${encodeURIComponent(seeded.tree)}`;

test('undo removes a child the tree is showing, and redo brings it back', async ({
  page,
  request,
  baseURL,
}) => {
  await post(request, baseURL!, `${base()}/people/${seeded.rowan}/children`, {
    person: { sex: 'M', names: [{ given: 'Tobias', surname: 'Ashdown' }] },
  });
  await openTree(page);
  await expect(card(page, 'Tobias Ashdown')).toBeAttached();
  await card(page, 'Rowan Ashdown').focus();

  await page.keyboard.press(`${mod}+z`);
  await expect(card(page, 'Tobias Ashdown')).toHaveCount(0);
  await expect(card(page, 'Rowan Ashdown')).toBeAttached();

  await page.keyboard.press(`Shift+${mod}+z`);
  await expect(card(page, 'Tobias Ashdown')).toBeAttached();
});

test('undo removes a partner the tree is showing, and redo brings them back', async ({
  page,
  request,
  baseURL,
}) => {
  await post(request, baseURL!, `${base()}/people/${seeded.rowan}/spouses`, {
    person: { sex: 'F', names: [{ given: 'Mabel', surname: 'Orr' }] },
  });
  await openTree(page);
  await expect(card(page, 'Mabel Orr')).toBeAttached();
  await expect(card(page, 'Iris Vale')).toBeAttached();
  await card(page, 'Rowan Ashdown').focus();

  await page.keyboard.press(`${mod}+z`);
  await expect(card(page, 'Mabel Orr')).toHaveCount(0);
  await expect(card(page, 'Iris Vale')).toBeAttached();

  await page.keyboard.press(`Shift+${mod}+z`);
  await expect(card(page, 'Mabel Orr')).toBeAttached();
});

test('a guessed layout is not reused after an undo changes the person', async ({
  page,
  request,
  baseURL,
}) => {
  // Add a child to Edmund (Rowan's father), so his own view shows it.
  await post(request, baseURL!, `${base()}/people/${seeded.edmund}/children`, {
    person: { sex: 'F', names: [{ given: 'Hester', surname: 'Ashdown' }] },
  });
  await openTree(page);
  // Rest the keyboard on Edmund so his layout is prepared ahead.
  await card(page, 'Rowan Ashdown').focus();
  await page.keyboard.press('ArrowUp');
  await expect(card(page, 'Edmund Ashdown')).toBeFocused();
  await page.waitForTimeout(400);
  // Undo the child, then re-focus on Edmund: no stale Hester.
  await page.keyboard.press(`${mod}+z`);
  await expect(card(page, 'Hester Ashdown')).toHaveCount(0);
  await card(page, 'Edmund Ashdown').focus();
  await page.keyboard.press('Enter');
  await expect(card(page, 'Edmund Ashdown')).toHaveAccessibleName(/focus person/);
  await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
  await expect(card(page, 'Rowan Ashdown')).toBeAttached();
  await expect(card(page, 'Hester Ashdown')).toHaveCount(0);
});

test('generations loaded by a chevron come back after an undo', async ({
  page,
  request,
  baseURL,
}) => {
  await post(request, baseURL!, `${base()}/people/${seeded.edmund}/parents`, {
    person: { sex: 'M', names: [{ given: 'Silas', surname: 'Ashdown' }] },
  });
  const silas = (
    (await (
      await request.get(`${base()}/neighborhood?focus=${seeded.edmund}&up=1&down=0`)
    ).json()) as {
      people: { id: string; given: string }[];
    }
  ).people.find((p) => p.given === 'Silas')!.id;
  await post(request, baseURL!, `${base()}/people/${silas}/parents`, {
    person: { sex: 'M', names: [{ given: 'Abner', surname: 'Ashdown' }] },
  });
  await post(request, baseURL!, `${base()}/people/${seeded.rowan}/children`, {
    person: { sex: 'M', names: [{ given: 'Tobias', surname: 'Ashdown' }] },
  });
  await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), seeded.tree);
  // One generation up: Edmund's parents are past the first request.
  await page.goto(`/tree/${seeded.rowan}?tree=${encodeURIComponent(seeded.tree)}&up=1`);
  await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
  await canvas(page).getByRole('button', { name: 'Show parents of Edmund Ashdown' }).click();
  await expect(card(page, 'Silas Ashdown')).toBeAttached();
  // Silas's parents were not in any request yet: this chevron loads them.
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  await expect(page.getByTestId('tree-world')).not.toHaveAttribute('data-animating');
  await canvas(page).getByRole('button', { name: 'Show parents of Silas Ashdown' }).click();
  await expect(card(page, 'Abner Ashdown')).toBeAttached();

  await card(page, 'Rowan Ashdown').focus();
  await page.keyboard.press(`${mod}+z`);
  await expect(card(page, 'Tobias Ashdown')).toHaveCount(0);
  await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
  await expect(card(page, 'Abner Ashdown')).toBeAttached();
});
