import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { readSeed } from './tree-view-fixtures';

/*
 * The family tree view (F9) against the real server, on the synthetic family
 * seeded by global-setup.ts (see tree-view-fixtures.ts for the shape).
 */

const seed = readSeed();
const { tree, ids } = seed.family;
const treeUrl = (key: string, extra = '') =>
  `/tree/${ids[key]}?tree=${encodeURIComponent(tree)}${extra}`;

const canvas = (page: Page) => page.getByRole('application', { name: /^Family tree/ });
/** A card by the person's name (labels start with the name). */
const card = (page: Page, name: string) =>
  canvas(page).getByRole('button', { name: new RegExp(`^${name},`) });
const world = (page: Page) => page.getByTestId('tree-world');

async function open(page: Page, key = 'ada', extra = '') {
  await page.goto(treeUrl(key, extra));
  await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
}

/** Waits for pan/zoom animations to finish. */
async function settled(page: Page) {
  await expect(world(page)).not.toHaveAttribute('data-animating');
}

async function fit(page: Page) {
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  await settled(page);
}

async function transform(page: Page) {
  const el = world(page);
  return {
    x: Number(await el.getAttribute('data-x')),
    y: Number(await el.getAttribute('data-y')),
    scale: Number(await el.getAttribute('data-scale')),
  };
}

async function activeKey(page: Page) {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key ?? null);
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('not visible');
  return b;
}

test.describe('family view', () => {
  // Fit keeps this family above the 35% canvas level of detail, so cards stay mounted.
  test.use({ viewport: { width: 1440, height: 900 } });

  test('shows the focus person with spouses, parents, grandparents, children, siblings, aunts and uncles', async ({
    page,
  }) => {
    await open(page);
    await expect(canvas(page)).toHaveAccessibleName(/Ada Vale/);
    await expect(card(page, 'Ada Vale')).toHaveAccessibleName(/1941–Living.*focus person/);
    const expected: [string, RegExp][] = [
      ['Bram Vale', /1911–1957, father of Ada Vale/],
      ['Elsa Hale', /mother of Ada Vale/],
      ['Otto Vale', /grandfather of Ada Vale/],
      ['Greta Hale', /grandmother of Ada Vale/],
      ['Piers Hale', /grandfather of Ada Vale/],
      ['Rhea Lund', /grandmother of Ada Vale/],
      ['Abel Vale', /great-grandfather of Ada Vale/],
      ['Hugo Vale', /brother of Ada Vale/],
      ['Ilsa Vale', /sister of Ada Vale/],
      ['Fenn Vale', /uncle of Ada Vale/],
      ['Tilda Hale', /aunt of Ada Vale/],
      ['Corin Ash', /husband of Ada Vale/],
      ['Lucan Reed', /husband of Ada Vale/],
      ['Wren Ash', /daughter of Ada Vale/],
      ['Tobin Ash', /son of Ada Vale/],
      ['Mira Reed', /daughter of Ada Vale/],
      ['Juno Hart', /granddaughter of Ada Vale/],
    ];
    for (const [name, label] of expected) {
      await expect(card(page, name), name).toHaveAccessibleName(label);
    }
    // Generation labels are relative to the focus person.
    for (const label of [
      'Ada’s great-grandparents',
      'Ada’s grandparents',
      'Ada’s parents',
      'Ada’s children',
      'Ada’s grandchildren',
    ]) {
      await expect(canvas(page).getByText(label, { exact: true })).toBeVisible();
    }
    // Parents sit above the focus row, children below.
    const ada = await box(card(page, 'Ada Vale'));
    await fit(page);
    expect((await box(card(page, 'Bram Vale'))).y).toBeLessThan(
      (await box(card(page, 'Ada Vale'))).y,
    );
    expect((await box(card(page, 'Wren Ash'))).y).toBeGreaterThan(
      (await box(card(page, 'Ada Vale'))).y,
    );
    expect(ada.width).toBeGreaterThan(0);
    // Edges are drawn (and not collapsed to nothing by a size rule).
    const edges = page.getByTestId('tree-edges');
    await expect(edges.locator('path').first()).toHaveAttribute('d', /^M/);
    expect(await edges.evaluate((svg) => svg.getBoundingClientRect().width)).toBeGreaterThan(0);
  });

  test('a card click opens the quick view and Profile opens the person page', async ({ page }) => {
    await open(page);
    await card(page, 'Bram Vale').click();
    const quick = page.getByRole('dialog', { name: 'Bram Vale' });
    await expect(quick).toBeVisible();
    await expect(quick).toContainText('Born 5 Sep 1911');
    await expect(quick).toContainText('Died 5 Sep 1957');
    await expect(card(page, 'Bram Vale')).toHaveAttribute('aria-expanded', 'true');
    await quick.getByRole('link', { name: 'Profile' }).click();
    await expect(page).toHaveURL(new RegExp(`/person/${ids.bram}$`));
  });

  test('Escape closes the quick view and returns focus to the card', async ({ page }) => {
    await open(page);
    await card(page, 'Elsa Hale').click();
    await expect(page.getByRole('dialog', { name: 'Elsa Hale' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(card(page, 'Elsa Hale')).toBeFocused();
  });

  test('Make focus, Enter and double click re-center and the URL follows, with history', async ({
    page,
  }) => {
    await open(page);
    await card(page, 'Bram Vale').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Make focus' }).click();
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.bram}\\?`));
    await expect(card(page, 'Bram Vale')).toHaveAccessibleName(/focus person/);
    await expect(card(page, 'Fenn Vale')).toHaveAccessibleName(/brother of Bram Vale/);

    await card(page, 'Otto Vale').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.otto}\\?`));
    await expect(card(page, 'Otto Vale')).toHaveAccessibleName(/focus person/);

    await card(page, 'Fenn Vale').dblclick();
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.fenn}\\?`));

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.otto}\\?`));
    await expect(card(page, 'Otto Vale')).toHaveAccessibleName(/focus person/);
    await page.goBack();
    await page.goBack();
    await expect(card(page, 'Ada Vale')).toHaveAccessibleName(/focus person/);
  });

  test('the focus card stays centered after re-focus', async ({ page }) => {
    await open(page);
    const viewport = await box(canvas(page));
    await card(page, 'Wren Ash').dblclick();
    await expect(card(page, 'Wren Ash')).toHaveAccessibleName(/focus person/);
    await expect
      .poll(async () => {
        const b = await box(card(page, 'Wren Ash'));
        return Math.abs(b.x + b.width / 2 - (viewport.x + viewport.width / 2));
      })
      .toBeLessThan(2);
  });

  test('expanding ancestors reveals fetched generations and lazy-loads more without moving the focus card', async ({
    page,
  }) => {
    await open(page);
    await fit(page);
    const before = await box(card(page, 'Ada Vale'));
    await expect(card(page, 'Ezra Vale')).toHaveCount(0);
    await canvas(page).getByRole('button', { name: 'Show parents of Abel Vale' }).click();
    await expect(card(page, 'Ezra Vale')).toBeVisible();
    await expect(card(page, 'Nell Crane')).toBeAttached();
    expect(await box(card(page, 'Ada Vale'))).toEqual(before);

    // Ezra's parents are past the first request: expanding fetches them.
    await fit(page);
    const fitted = await box(card(page, 'Ada Vale'));
    const request = page.waitForRequest(
      (r) => r.url().includes('/neighborhood') && r.url().includes(`focus=${ids.ezra}`),
    );
    await canvas(page).getByRole('button', { name: 'Show parents of Ezra Vale' }).click();
    await request;
    await expect(card(page, 'Silas Vale')).toBeAttached();
    await expect(card(page, 'Maud Penn')).toBeAttached();

    await canvas(page).getByRole('button', { name: 'Hide parents of Abel Vale' }).click();
    await expect(card(page, 'Ezra Vale')).toHaveCount(0);
    expect(await box(card(page, 'Ada Vale'))).toEqual(fitted);
  });

  test('descendants and siblings collapse and expand', async ({ page }) => {
    await open(page);
    await canvas(page).getByRole('button', { name: 'Hide children of Ada Vale' }).click();
    await expect(card(page, 'Wren Ash')).toHaveCount(0);
    await canvas(page).getByRole('button', { name: 'Show children of Ada Vale' }).click();
    await expect(card(page, 'Wren Ash')).toBeVisible();
    await canvas(page).getByRole('button', { name: 'Hide siblings of Ada Vale' }).click();
    await expect(card(page, 'Hugo Vale')).toHaveCount(0);
    await canvas(page).getByRole('button', { name: 'Show siblings of Ada Vale' }).click();
    await expect(card(page, 'Hugo Vale')).toBeAttached();
  });

  test('sibling and aunt/uncle chevrons reveal nephews, nieces and cousins', async ({ page }) => {
    await open(page);
    await fit(page);
    await expect(card(page, 'Nico Vale')).toHaveCount(0);
    await canvas(page).getByRole('button', { name: 'Show children of Hugo Vale' }).click();
    await expect(card(page, 'Nico Vale')).toHaveAccessibleName(/nephew of Ada Vale/);
    await expect(card(page, 'Cass Vale')).toHaveCount(0);
    await canvas(page).getByRole('button', { name: 'Show children of Fenn Vale' }).click();
    await expect(card(page, 'Cass Vale')).toHaveAccessibleName(/cousin of Ada Vale/);
    await canvas(page).getByRole('button', { name: 'Hide children of Hugo Vale' }).click();
    await expect(card(page, 'Nico Vale')).toHaveCount(0);
  });

  test('a failed side branch still shows the tree, with a retry', async ({ page }) => {
    const blocked = (url: URL) =>
      url.pathname.endsWith('/neighborhood') &&
      [ids.otto, ids.greta].includes(url.searchParams.get('focus') ?? '');
    await page.route(blocked, (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal_error', message: 'x' } } }),
    );
    await open(page);
    const notice = page
      .getByRole('status')
      .filter({ hasText: 'Some relatives could not be loaded' });
    await expect(notice).toBeVisible();
    await expect(card(page, 'Bram Vale')).toBeAttached();
    await expect(card(page, 'Fenn Vale')).toHaveCount(0);
    await page.unroute(blocked);
    await notice.getByRole('button', { name: 'Retry' }).click();
    await expect(card(page, 'Fenn Vale')).toBeAttached();
    await expect(notice).toHaveCount(0);
  });

  test('keyboard focus survives zooming in and out of the canvas level of detail', async ({
    page,
  }) => {
    await open(page);
    await card(page, 'Ada Vale').focus();
    // Zoom out past 35%, where cards are painted on a canvas.
    for (let i = 0; i < 6; i++) await page.keyboard.press('-');
    await settled(page);
    expect((await transform(page)).scale).toBeLessThan(0.35);
    expect(await activeKey(page)).toBe(ids.ada);
    await page.keyboard.press('ArrowUp');
    expect(await activeKey(page)).toBe(ids.bram);
    // And back to mounted cards.
    await page.keyboard.press('0');
    await settled(page);
    expect((await transform(page)).scale).toBeGreaterThan(0.35);
    expect(await activeKey(page)).toBe(ids.bram);
    await page.keyboard.press('ArrowRight');
    expect(await activeKey(page)).toBe(ids.elsa);
  });

  test('a click on empty canvas keeps the tree shortcuts working', async ({ page }) => {
    await open(page);
    const viewport = await box(canvas(page));
    await page.mouse.click(viewport.x + viewport.width - 40, viewport.y + viewport.height - 40);
    await expect(canvas(page)).toBeFocused();
    const before = await transform(page);
    await page.keyboard.press('+');
    await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(before.scale);
    await settled(page);
    const zoomed = await transform(page);
    await page.keyboard.press('ArrowLeft');
    expect((await transform(page)).x).toBeGreaterThan(zoomed.x);
  });

  test('arrow keys move between related cards', async ({ page }) => {
    await open(page);
    await card(page, 'Ada Vale').focus();
    await page.keyboard.press('ArrowUp');
    expect(await activeKey(page)).toBe(ids.bram);
    await page.keyboard.press('ArrowUp');
    expect(await activeKey(page)).toBe(ids.otto);
    await page.keyboard.press('ArrowDown');
    expect(await activeKey(page)).toBe(ids.bram);
    await page.keyboard.press('ArrowRight');
    expect(await activeKey(page)).toBe(ids.elsa);
    await page.keyboard.press('ArrowLeft');
    expect(await activeKey(page)).toBe(ids.bram);
    await page.keyboard.press('ArrowDown');
    expect([ids.ada, ids.hugo, ids.ilsa]).toContain(await activeKey(page));

    await card(page, 'Ada Vale').focus();
    await page.keyboard.press('ArrowDown');
    expect([ids.wren, ids.tobin, ids.mira]).toContain(await activeKey(page));

    // One Tab stop: only the active card is tabbable.
    await expect(canvas(page).locator('[data-key][tabindex="0"]')).toHaveCount(1);
    // Space opens the quick view on the active card.
    await card(page, 'Ada Vale').focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog', { name: 'Ada Vale' })).toBeVisible();
  });

  test('zoom in, zoom out, fit, wheel, drag and home', async ({ page }) => {
    await open(page, 'bram');
    const start = await transform(page);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(start.scale);
    await page.keyboard.press('Escape');
    await card(page, 'Bram Vale').focus();
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    await expect.poll(async () => (await transform(page)).scale).toBeLessThan(start.scale);

    await page.keyboard.press('0');
    await settled(page);
    const viewport = await box(canvas(page));
    for (const name of ['Abel Vale', 'Wren Ash', 'Mira Reed', 'Fenn Vale']) {
      const b = await box(card(page, name));
      expect(b.x).toBeGreaterThanOrEqual(viewport.x);
      expect(b.y).toBeGreaterThanOrEqual(viewport.y);
      expect(b.x + b.width).toBeLessThanOrEqual(viewport.x + viewport.width);
      expect(b.y + b.height).toBeLessThanOrEqual(viewport.y + viewport.height);
    }

    // Ctrl + wheel (trackpad pinch) zooms around the cursor.
    const fitted = await transform(page);
    const cx = viewport.x + viewport.width / 2 + 40;
    const cy = viewport.y + viewport.height / 2;
    await page.mouse.move(cx, cy);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -200);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(fitted.scale);
    const zoomed = await transform(page);
    const worldX = (t: typeof zoomed) => (cx - viewport.x - t.x) / t.scale;
    expect(Math.abs(worldX(zoomed) - worldX(fitted))).toBeLessThan(1);

    // A mouse wheel notch zooms out around the cursor too (map style).
    await page.mouse.wheel(0, 100);
    await expect.poll(async () => (await transform(page)).scale).toBeLessThan(zoomed.scale);
    const wheeled = await transform(page);
    expect(Math.abs(worldX(wheeled) - worldX(zoomed))).toBeLessThan(1);
    // A trackpad's two-finger scroll (small, two-axis deltas) pans.
    await page.mouse.wheel(6, 12.5);
    await expect.poll(async () => (await transform(page)).y).toBeLessThan(wheeled.y);
    expect((await transform(page)).scale).toBe(wheeled.scale);
    const beforeDrag = await transform(page);
    // Dragging works anywhere on the canvas, cards included.
    await page.mouse.move(viewport.x + viewport.width - 250, viewport.y + 80);
    await page.mouse.down();
    await page.mouse.move(viewport.x + viewport.width - 150, viewport.y + 30, { steps: 5 });
    await page.mouse.up();
    const dragged = await transform(page);
    expect(dragged.x - beforeDrag.x).toBeCloseTo(100, 0);
    expect(dragged.y - beforeDrag.y).toBeCloseTo(-50, 0);

    await page.getByRole('button', { name: 'Go to home person' }).click();
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.ada}\\?`));
    await card(page, 'Ada Vale').focus();
    await settled(page);
    await card(page, 'Elsa Hale').dblclick();
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.elsa}\\?`));
    // Keyboard focus follows to the new focus card.
    await expect(card(page, 'Elsa Hale')).toBeFocused();
    await page.keyboard.press('h');
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.ada}\\?`));

    // Single-key shortcuts only act while focus is in the tree (WCAG 2.1.4).
    await expect(card(page, 'Ada Vale')).toHaveAccessibleName(/focus person/);
    await card(page, 'Bram Vale').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.bram}\\?`));
    await page.getByRole('banner').getByRole('button', { name: 'File' }).focus();
    await page.keyboard.press('h');
    await page.keyboard.press('0');
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.bram}\\?`));
  });

  test('the first view frames grandparents to children', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page);
    await settled(page);
    const viewport = await box(canvas(page));
    for (const name of ['Otto Vale', 'Rhea Lund', 'Ada Vale', 'Wren Ash', 'Mira Reed']) {
      const b = await box(card(page, name));
      expect(b.y, name).toBeGreaterThanOrEqual(viewport.y);
      expect(b.y + b.height, name).toBeLessThanOrEqual(viewport.y + viewport.height);
    }
    await expect(canvas(page).getByText('Ada’s grandparents')).toBeInViewport();
  });

  test('the minimap shows the viewport and navigates on click and drag', async ({ page }) => {
    await open(page);
    const minimap = page.getByRole('application', { name: 'Minimap' });
    await expect(minimap).toBeVisible();
    const m = await box(minimap);
    const start = await transform(page);
    await page.mouse.click(m.x + 10, m.y + 10);
    await expect.poll(async () => (await transform(page)).x).not.toBe(start.x);
    const clicked = await transform(page);
    await page.mouse.move(m.x + 20, m.y + 20);
    await page.mouse.down();
    await page.mouse.move(m.x + m.width - 20, m.y + m.height - 20, { steps: 4 });
    await page.mouse.up();
    const dragged = await transform(page);
    expect(dragged.x).toBeLessThan(clicked.x);
    expect(dragged.y).toBeLessThan(clicked.y);

    await minimap.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await transform(page)).x).toBeGreaterThan(dragged.x);

    await page.getByRole('button', { name: 'Hide minimap' }).click();
    await expect(minimap).toHaveCount(0);
    // The toolbar brings it back (and M toggles it).
    const toggle = page.getByRole('toolbar', { name: 'Tree tools' }).getByRole('button', {
      name: 'Minimap',
    });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(minimap).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('m');
    await expect(minimap).toHaveCount(0);
  });

  test('pedigree collapse renders a linked duplicate that jumps to the original', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await open(page);
    await fit(page);
    await expect(card(page, 'Jonas Hale')).toHaveCount(2);
    const duplicate = canvas(page).getByRole('button', {
      name: /^Jonas Hale,.*duplicate, also shown elsewhere/,
    });
    await expect(duplicate).toHaveCount(1);
    await duplicate.click();
    await expect.poll(() => activeKey(page)).toBe(ids.jonas);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The original is brought into view.
    await settled(page);
    const original = await box(canvas(page).locator(`[data-key="${ids.jonas}"]`));
    const viewport = await box(canvas(page));
    expect(
      Math.abs(original.x + original.width / 2 - (viewport.x + viewport.width / 2)),
    ).toBeLessThan(2);
    expect(errors).toEqual([]);
  });

  test('multiple spouses each show with their own children', async ({ page }) => {
    await open(page);
    const corin = await box(card(page, 'Corin Ash'));
    const lucan = await box(card(page, 'Lucan Reed'));
    const mira = await box(card(page, 'Mira Reed'));
    const wren = await box(card(page, 'Wren Ash'));
    expect(Math.abs(mira.x - lucan.x)).toBeLessThan(Math.abs(mira.x - corin.x));
    expect(Math.abs(wren.x - corin.x)).toBeLessThan(Math.abs(wren.x - lucan.x));
  });

  test('the parent set switcher shows the adoptive parents', async ({ page }) => {
    await open(page);
    await expect(card(page, 'Rolf Grey')).toHaveCount(0);
    const switcher = canvas(page).getByRole('button', { name: /^Switch parents of Ada Vale/ });
    await expect(switcher).toHaveAccessibleName(/1 of 2/);
    await switcher.click();
    await expect(card(page, 'Rolf Grey')).toBeAttached();
    await expect(card(page, 'Una Grey')).toBeAttached();
    await expect(card(page, 'Bram Vale')).toHaveCount(0);
    await expect(
      canvas(page).getByRole('button', { name: /^Switch parents of Ada Vale/ }),
    ).toHaveAccessibleName(/2 of 2/);
  });

  test('find in tree re-centers on the chosen person', async ({ page }) => {
    await open(page, 'ada', '&layout=pedigree');
    await page.getByRole('button', { name: 'Find in tree' }).click();
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await page.keyboard.type('Tilda');
    await dialog.getByRole('option', { name: /Tilda Hale/ }).click();
    // The tree re-focuses and keeps its view settings.
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.tilda}\\?.*layout=pedigree`));
    await card(page, 'Tilda Hale').focus();
    await page.keyboard.press('f');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  });

  test('the layout switch shows pedigree, descendants and fan views', async ({ page }) => {
    await open(page);
    const pick = async (name: string) => {
      await page.getByRole('button', { name: /^Layout:/ }).click();
      await page.getByRole('menuitemradio', { name }).click();
    };
    await pick('Pedigree');
    await expect(page).toHaveURL(/layout=pedigree/);
    await expect(card(page, 'Abel Vale')).toBeAttached();
    await expect(card(page, 'Wren Ash')).toHaveCount(0);
    const ada = await box(card(page, 'Ada Vale'));
    const bram = await box(card(page, 'Bram Vale'));
    expect(bram.x).toBeGreaterThan(ada.x);

    await pick('Descendants');
    await expect(page).toHaveURL(/layout=descendants/);
    await expect(card(page, 'Juno Hart')).toBeAttached();
    await expect(card(page, 'Bram Vale')).toHaveCount(0);

    await pick('Fan chart');
    await expect(page).toHaveURL(/layout=fan/);
    await expect(canvas(page).getByRole('button', { name: /^Bram Vale/ })).toBeAttached();
    await canvas(page)
      .getByRole('button', { name: /^Bram Vale/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.bram}\\?.*layout=fan`));

    await page.reload();
    await expect(page).toHaveURL(/layout=fan/);
    await pick('Family view');
    await expect(card(page, 'Fenn Vale')).toBeAttached();
  });

  test('a person with no tree data shows an empty state', async ({ page }) => {
    await page.goto(`/tree/nobody?tree=${encodeURIComponent(tree)}`);
    await expect(page.getByRole('heading', { name: 'Person not found' })).toBeVisible();
    await page.getByRole('link', { name: 'Go to the home person' }).click();
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.ada}\\?`));
  });

  test('/tree/home opens the home person', async ({ page }) => {
    await page.goto(`/tree/home?tree=${encodeURIComponent(tree)}`);
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.ada}\\?`));
    await expect(card(page, 'Ada Vale')).toHaveAccessibleName(/focus person/);
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`has no axe violations in the ${colorScheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await open(page);
      await page.evaluate(() => document.fonts.ready);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await card(page, 'Bram Vale').click();
      await expect(page.getByRole('dialog', { name: 'Bram Vale' })).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });
  }
});

test.describe('visual snapshots', () => {
  // Baselines are Linux Chromium only, like design.spec.ts.
  test.skip(
    ({ browserName }) => browserName !== 'chromium' || process.platform !== 'linux',
    'Linux Chromium baselines only',
  );

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`family view canvas (${colorScheme})`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await open(page);
      await page.evaluate(() => document.fonts.ready);
      await expect(canvas(page)).toHaveScreenshot(`tree-family-${colorScheme}.png`);
    });
  }
});
