import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { person, send, session, uniqueTreeName } from './edit-seed';
import { expect, test } from './fixtures';

/* Tag management (#57): categories and tags, filtering people and the tree. */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

let tree: string;
let rowan: string;
let iris: string;
let smiths: string;
let seedSession: Awaited<ReturnType<typeof session>>;

test.beforeEach(async ({ request, baseURL }, testInfo) => {
  const s = await session(request, baseURL!);
  seedSession = s;
  tree = uniqueTreeName('tags', `${testInfo.project.name} ${testInfo.title}`);
  await send(request, s, 'post', '/api/trees', { name: tree });
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  rowan = (
    await send<{ person: { id: string } }>(
      request,
      s,
      'post',
      `${base}/people`,
      person('Rowan', 'Ashdown', 'M', '1880'),
    )
  ).person.id;
  iris = (
    await send<{ spouseId: string }>(request, s, 'post', `${base}/people/${rowan}/spouses`, {
      person: person('Iris', 'Vale', 'F', '1885'),
    })
  ).spouseId;
  await send(request, s, 'put', `${base}/home`, { personId: rowan });
  const { tag } = await send<{ tag: { id: string } }>(request, s, 'post', `${base}/tags`, {
    name: 'Smiths',
    category: 'Occupation',
  });
  await send(request, s, 'post', `${base}/people/${rowan}/tags`, { tagId: tag.id });
  smiths = tag.id;
});

async function openTags(page: Page) {
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto('/tags');
  await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible();
  await page.locator('html[data-shell-ready]').waitFor({ state: 'attached' });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

const category = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('creates, edits, recolors and deletes tags, with undo', async ({ page }) => {
  await openTags(page);
  await page.getByRole('button', { name: 'New tag' }).click();
  let dialog = page.getByRole('dialog', { name: 'New tag' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Brick wall');
  await dialog.getByRole('combobox', { name: 'Category' }).fill('Research');
  await dialog.getByRole('radio', { name: 'Violet' }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(category(page, 'Research').getByText('Brick wall')).toBeVisible();

  await category(page, 'Research').getByRole('button', { name: 'Edit tag Brick wall' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit tag' });
  await expect(dialog.getByRole('radio', { name: 'Violet' })).toBeChecked();
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Brick walls');
  await dialog.getByRole('radio', { name: 'Red' }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(category(page, 'Research').getByText('Brick walls')).toBeVisible();

  await category(page, 'Research').getByRole('button', { name: 'Delete tag Brick walls' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete tag' }).click();
  await expect(category(page, 'Research')).toHaveCount(0);
  await page.keyboard.press(`${mod}+z`);
  await expect(category(page, 'Research').getByText('Brick walls')).toBeVisible();
});

test('renames and deletes a category in one undo step each', async ({ page }) => {
  await openTags(page);
  await category(page, 'Occupation').getByRole('button', { name: 'Rename category' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename category' });
  await dialog.getByRole('textbox', { name: 'Category name' }).fill('Trades');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(category(page, 'Trades').getByText('Smiths')).toBeVisible();

  await category(page, 'Trades').getByRole('button', { name: 'Delete category' }).click();
  const confirm = page.getByRole('alertdialog', {
    name: 'Delete the Trades category and its 1 tag?',
  });
  await confirm.getByRole('button', { name: 'Delete category' }).click();
  await expect(page.getByRole('heading', { name: 'No tags yet' })).toBeVisible();
  await page.keyboard.press(`${mod}+z`);
  await expect(category(page, 'Trades').getByText('Smiths')).toBeVisible();
});

test('filters the people list and highlights the tree by tag', async ({ page }) => {
  await openTags(page);
  const row = category(page, 'Occupation').getByRole('listitem').filter({ hasText: 'Smiths' });
  await expect(row).toContainText('1 person');
  await row.getByRole('link', { name: 'Show people' }).click();
  await expect(page).toHaveURL(/\/people\?.*tag=/);
  await expect(page.getByTestId('people-count')).toHaveText('1 person');

  await page.goBack();
  await category(page, 'Occupation')
    .getByRole('listitem')
    .filter({ hasText: 'Smiths' })
    .getByRole('link', { name: 'Highlight in tree' })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Highlighting people tagged Smiths' }),
  ).toBeVisible();
  const card = (name: string) => page.locator(`[data-key][aria-label^="${name}"]`).first();
  await expect(card('Rowan Ashdown')).toBeVisible();
  await expect(card('Rowan Ashdown')).not.toHaveAttribute('data-dimmed', /.*/);
  await expect(card('Iris Vale')).toHaveAttribute('data-dimmed', 'true');
  expect(iris).not.toBe(rowan);

  await page.getByRole('button', { name: 'Clear highlight' }).click();
  await expect(card('Iris Vale')).not.toHaveAttribute('data-dimmed', /.*/);
});

test('dims other cards without fading their text, and marks the tagged ones', async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto(`/tree/${rowan}?tag=${smiths}`);
  const card = (name: string) => page.locator(`[data-key][aria-label^="${name}"]`).first();
  await expect(card('Iris Vale')).toHaveAttribute('data-dimmed', 'true');
  await expect(card('Rowan Ashdown')).toHaveAttribute('data-highlighted', 'true');
  await expect(card('Rowan Ashdown').getByTestId('tag-highlight')).toBeVisible();
  // Nothing on a dimmed card is see-through, so its text keeps full contrast.
  const opacities = await card('Iris Vale').evaluate((el) =>
    [el, ...el.querySelectorAll('*')].map((e) => getComputedStyle(e).opacity),
  );
  expect(new Set(opacities)).toEqual(new Set(['1']));
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const results = await new AxeBuilder({ page }).include('[data-key]').analyze();
    expect(results.violations, colorScheme).toEqual([]);
  }
});

test('counts tagged people and steps to those out of view', async ({ page, request }) => {
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  const wren = (
    await send<{ person: { id: string } }>(
      request,
      seedSession,
      'post',
      `${base}/people`,
      person('Wren', 'Hollis', 'F', '1900'),
    )
  ).person.id;
  await send(request, seedSession, 'post', `${base}/people/${wren}/tags`, { tagId: smiths });
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto(`/tree/${rowan}?tag=${smiths}`);
  const pill = page.getByRole('status').filter({ hasText: 'tagged Smiths' });
  await expect(pill).toContainText('2 tagged, 1 shown');
  await pill.getByRole('button', { name: 'Next tagged person' }).click();
  await expect(page).toHaveURL(new RegExp(`/tree/${wren}\\?.*tag=${smiths}`));
  const card = (name: string) => page.locator(`[data-key][aria-label^="${name}"]`).first();
  await expect(card('Wren Hollis')).toHaveAttribute('data-highlighted', 'true');
  await pill.getByRole('button', { name: 'Next tagged person' }).click();
  await expect(page).toHaveURL(new RegExp(`/tree/${rowan}\\?`));
});

test('highlights in the fan chart too', async ({ page, request }) => {
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  await send(request, seedSession, 'post', `${base}/people/${rowan}/parents`, {
    person: person('Edmund', 'Ashdown', 'M', '1850'),
  });
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto(`/tree/${rowan}?tag=${smiths}&layout=fan`);
  const fan = page.getByTestId('tree-fan');
  const rowanSegment = fan.getByRole('button', { name: /^Rowan Ashdown/ });
  await expect(rowanSegment).toHaveAttribute('data-highlighted', 'true');
  await expect(rowanSegment).toHaveAccessibleName(/tagged Smiths/);
  await expect(fan.getByRole('button', { name: /^Edmund Ashdown/ })).toHaveAttribute(
    'data-dimmed',
    'true',
  );
});

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('keeps the top-of-tree notice clear of the highlight pill', async ({ page, request }) => {
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  await send(request, seedSession, 'post', `${base}/people/${rowan}/parents`, {
    person: person('Edmund', 'Ashdown', 'M', '1850'),
  });
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto(`/tree/${rowan}?tag=${smiths}&layout=fan&up=10`);
  const note = page.getByRole('status').filter({ hasText: 'The fan shows 6 generations' });
  const pill = page.getByRole('status').filter({ hasText: 'tagged Smiths' });
  await expect(note).toBeVisible();
  await expect(pill).toBeVisible();
  expect(overlaps((await note.boundingBox())!, (await pill.boundingBox())!)).toBe(false);
  // Nothing on top of the link: a click reaches it.
  await note.getByRole('link', { name: 'Open the pedigree' }).click({ trial: true });
  await note.getByRole('link', { name: 'Open the pedigree' }).click();
  await expect(page).toHaveURL(/layout=pedigree/);
});

test.describe('highlight pill on a phone', () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ request }) => {
    // Grandparents to children: more rows than fit, so the view starts at the top.
    const base = `/api/trees/${encodeURIComponent(tree)}`;
    const parent = async (child: string, name: string, sex: 'M' | 'F', year: string) =>
      (
        await send<{ parentId: string }>(
          request,
          seedSession,
          'post',
          `${base}/people/${child}/parents`,
          {
            person: person(name, 'Ashdown', sex, year),
          },
        )
      ).parentId;
    const edmund = await parent(rowan, 'Edmund', 'M', '1850');
    await parent(rowan, 'Clara', 'F', '1853');
    await parent(edmund, 'Silas', 'M', '1820');
    await parent(edmund, 'Maud', 'F', '1824');
    await send(request, seedSession, 'post', `${base}/people/${rowan}/children`, {
      person: person('Tobias', 'Ashdown', 'M', '1910'),
    });
  });

  test('leaves the focus card and the rows above it uncovered', async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
    await page.goto(`/tree/${rowan}?tag=${smiths}`);
    const pill = page.getByRole('status').filter({ hasText: 'tagged Smiths' });
    await expect(pill).toBeVisible();
    await expect(page.getByTestId('tree-world')).not.toHaveAttribute('data-animating');
    const pillBox = (await pill.boundingBox())!;
    for (const name of ['Rowan Ashdown', 'Edmund Ashdown', 'Silas Ashdown']) {
      const card = page.locator(`[data-key][aria-label^="${name}"]`).first();
      await expect(card).toBeVisible();
      expect(overlaps((await card.boundingBox())!, pillBox), name).toBe(false);
    }
  });

  test('reframes when the pill arrives after the first view', async ({ page }) => {
    // The tagged people load after the tree has framed itself: the pill then
    // takes room at the top, and the untouched view moves down to clear it.
    await page.route('**/api/trees/*/tags/*/people', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
    await page.goto(`/tree/${rowan}?tag=${smiths}`);
    await expect(page.locator('[data-key][aria-label^="Rowan Ashdown"]').first()).toBeVisible();
    const pill = page.getByRole('status').filter({ hasText: 'tagged Smiths' });
    await expect(pill).toBeVisible();
    const pillBox = (await pill.boundingBox())!;
    for (const name of ['Rowan Ashdown', 'Edmund Ashdown', 'Silas Ashdown']) {
      const card = page.locator(`[data-key][aria-label^="${name}"]`).first();
      await expect
        .poll(async () => overlaps((await card.boundingBox())!, pillBox), { message: name })
        .toBe(false);
    }
  });

  test('keeps a view the reader moved when the pill arrives', async ({ page }) => {
    await page.route('**/api/trees/*/tags/*/people', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
    await page.goto(`/tree/${rowan}?tag=${smiths}`);
    const world = page.getByTestId('tree-world');
    await expect(page.locator('[data-key][aria-label^="Rowan Ashdown"]').first()).toBeVisible();
    await expect(world).not.toHaveAttribute('data-animating');
    const framed = await world.getAttribute('data-scale');
    await page.locator('[data-key][aria-label^="Rowan Ashdown"]').first().focus();
    await page.keyboard.press('+');
    await expect(world).not.toHaveAttribute('data-scale', framed!);
    await expect(world).not.toHaveAttribute('data-animating');
    const moved = await world.getAttribute('data-y');
    await expect(page.getByRole('status').filter({ hasText: 'tagged Smiths' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(await world.getAttribute('data-y')).toBe(moved);
  });

  test('gives the pill buttons 44px touch targets', async ({ page, request }) => {
    const base = `/api/trees/${encodeURIComponent(tree)}`;
    const wren = (
      await send<{ person: { id: string } }>(
        request,
        seedSession,
        'post',
        `${base}/people`,
        person('Wren', 'Hollis', 'F', '1900'),
      )
    ).person.id;
    await send(request, seedSession, 'post', `${base}/people/${wren}/tags`, { tagId: smiths });
    await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
    await page.goto(`/tree/${rowan}?tag=${smiths}`);
    const pill = page.getByRole('status').filter({ hasText: 'tagged Smiths' });
    const buttons = pill.getByRole('button');
    await expect(buttons).toHaveCount(2);
    for (const button of await buttons.all()) {
      const b = (await button.boundingBox())!;
      const name = (await button.textContent()) ?? '';
      expect(b.height, name).toBeGreaterThanOrEqual(44);
      expect(b.width, name).toBeGreaterThanOrEqual(44);
    }
  });
});

test('is reachable from the command palette and the people list', async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto('/people');
  await page.getByRole('link', { name: 'Manage tags' }).click();
  await expect(page).toHaveURL(/\/tags$/);
  await page.locator('html[data-shell-ready]').waitFor({ state: 'attached' });
  await page.keyboard.press(`${mod}+k`);
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox'),
  ).toBeFocused();
  await page.keyboard.type('manage tags');
  await expect(page.getByRole('option', { name: 'Manage tags' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tags$/);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`tags page has no axe violations in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openTags(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}
