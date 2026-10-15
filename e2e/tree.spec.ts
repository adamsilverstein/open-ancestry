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

/**
 * The top bar's File button once its menu has loaded: until then a disabled
 * placeholder stands in, and focus on it is lost when the real one replaces it.
 */
async function fileMenu(page: Page) {
  const file = page.getByRole('banner').getByRole('button', { name: 'File' });
  await expect(file).not.toHaveAttribute('aria-disabled', 'true');
  return file;
}

/**
 * Waits until `name` is the laid-out focus person and the view has stopped
 * moving: the URL changes first, the layout and re-centering come after.
 */
async function focusedOn(page: Page, name: string) {
  await expect(card(page, name)).toHaveAccessibleName(/focus person/);
  await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
  await settled(page);
}

/** Waits for the minimap's pending corner check, so it is in its final corner. */
async function minimapRested(page: Page) {
  const minimap = page.getByTestId('tree-minimap');
  if (await minimap.count()) await expect(minimap).not.toHaveAttribute('data-settling');
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

  test('keyboard focus survives a chevron changing the layout', async ({ page }) => {
    await open(page);
    const hide = canvas(page).getByRole('button', { name: 'Hide children of Ada Vale' });
    await hide.focus();
    await page.keyboard.press('Enter');
    await expect(card(page, 'Wren Ash')).toHaveCount(0);
    // The chevron's card keeps focus, so the keyboard carries on from there.
    await expect(card(page, 'Ada Vale')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    expect(await activeKey(page)).toBe(ids.bram);
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

  test('the family view loads in one request, siblings and aunts included', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => {
      // API calls only: a build chunk can also be named after the neighborhood module.
      if (new URL(r.url()).pathname.startsWith('/api/') && r.url().includes('/neighborhood')) {
        requests.push(r.url());
      }
    });
    await open(page);
    await expect(card(page, 'Fenn Vale')).toBeAttached();
    await expect(card(page, 'Mae Orr')).toBeAttached();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('siblingsDepth=2');
  });

  test('a failed chevron load keeps the tree, with a retry', async ({ page }) => {
    const blocked = (url: URL) =>
      url.pathname.endsWith('/neighborhood') && url.searchParams.get('focus') === ids.hugo;
    await page.route(blocked, (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal_error', message: 'x' } } }),
    );
    await open(page);
    await fit(page);
    await canvas(page).getByRole('button', { name: 'Show children of Hugo Vale' }).click();
    const notice = page
      .getByRole('status')
      .filter({ hasText: 'Some relatives could not be loaded' });
    await expect(notice).toBeVisible();
    await expect(card(page, 'Ada Vale')).toBeAttached();
    await expect(card(page, 'Nico Vale')).toHaveCount(0);
    await page.unroute(blocked);
    await notice.getByRole('button', { name: 'Retry' }).click();
    await expect(card(page, 'Nico Vale')).toBeAttached();
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

  test('mid zoom shows lighter cards with the same names and labels', async ({ page }) => {
    await open(page);
    const ada = card(page, 'Ada Vale');
    const label = await ada.getAttribute('aria-label');
    await ada.focus();
    // Step out to between 35% and 60%: cards are DOM but drop avatar and badges.
    while ((await transform(page)).scale >= 0.6) {
      await page.keyboard.press('-');
      await settled(page);
    }
    expect((await transform(page)).scale).toBeGreaterThanOrEqual(0.35);
    await expect(ada).toBeFocused();
    await expect(ada).toHaveAttribute('aria-label', label!);
    await expect(ada).toContainText('Ada Vale');
    await expect(ada).toContainText('1941–Living');
    await expect(ada.locator('svg')).toHaveCount(0);
    // The quick view and re-focus work as at full detail.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.bram}\\?`));
    await expect(card(page, 'Bram Vale')).toBeFocused();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    // Back at full detail the avatar returns, and focus stays.
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await settled(page);
    expect((await transform(page)).scale).toBeGreaterThanOrEqual(0.6);
    await expect(card(page, 'Bram Vale')).toBeFocused();
    await expect(card(page, 'Bram Vale').locator('svg').first()).toBeAttached();
  });

  test('sweeping the pointer across cards prepares only where it rests', async ({ page }) => {
    await open(page);
    await fit(page);
    const requests: string[] = [];
    page.on('request', (r) => {
      const url = new URL(r.url());
      if (url.pathname.startsWith('/api/') && url.pathname.endsWith('/neighborhood')) {
        requests.push(url.searchParams.get('focus')!);
      }
    });
    // Pass over six cards without stopping (all within one task, so no dwell can
    // elapse even on a busy machine), then rest on the last one.
    const keys = [ids.otto, ids.greta, ids.piers, ids.rhea, ids.elsa, ids.tilda];
    await page.evaluate((list) => {
      for (const key of list) {
        document
          .querySelector(`[data-key="${key}"]`)!
          .dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      }
    }, keys);
    await page.waitForTimeout(600);
    expect(requests).toEqual([ids.tilda]);
  });

  test('a click on empty canvas keeps the tree shortcuts working', async ({ page }) => {
    await open(page);
    const viewport = await box(canvas(page));
    // Top right: the bottom corners can hold the minimap, which moves to stay off labels.
    await page.mouse.click(viewport.x + viewport.width - 40, viewport.y + 40);
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
    // The first view frames the family with an animation; measure from where it lands.
    await settled(page);
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
    // The new focus re-centers once its relatives load; a card is only a stable
    // target after that, not merely after the URL changed.
    await focusedOn(page, 'Ada Vale');
    await card(page, 'Ada Vale').focus();
    await settled(page);
    await card(page, 'Elsa Hale').dblclick();
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.elsa}\\?`));
    await focusedOn(page, 'Elsa Hale');
    // Keyboard focus follows to the new focus card.
    await expect(card(page, 'Elsa Hale')).toBeFocused();
    await page.keyboard.press('h');
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.ada}\\?`));
    await focusedOn(page, 'Ada Vale');

    // Single-key shortcuts only act while focus is in the tree (WCAG 2.1.4).
    await expect(card(page, 'Ada Vale')).toHaveAccessibleName(/focus person/);
    // Keyboard focus follows the re-focus to Ada; let it land before moving on.
    await expect(card(page, 'Ada Vale')).toBeFocused();
    await card(page, 'Bram Vale').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.bram}\\?`));
    await (await fileMenu(page)).focus();
    await page.keyboard.press('h');
    await page.keyboard.press('0');
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.bram}\\?`));
  });

  test('a re-focus that lands late does not take focus back from the top bar', async ({ page }) => {
    await open(page);
    await settled(page);
    // Hold Bram's relatives so his layout arrives after focus has moved on.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/neighborhood?focus=${ids.bram}*`, async (route) => {
      await held;
      await route.continue();
    });
    await card(page, 'Bram Vale').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.bram}\\?`));
    const file = await fileMenu(page);
    await file.focus();
    release();
    await focusedOn(page, 'Bram Vale');
    await expect(file).toBeFocused();
    // So the tree's single-key shortcuts stay off (WCAG 2.1.4).
    await page.keyboard.press('h');
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

  test('the minimap settles before it moves, and does not flip back and forth', async ({
    page,
  }) => {
    await open(page);
    await settled(page);
    const minimap = page.getByTestId('tree-minimap');
    await expect(minimap).toBeVisible();
    await minimap.evaluate((el) => {
      const w = window as unknown as { __cornerChanges: number };
      w.__cornerChanges = 0;
      new MutationObserver((records) => (w.__cornerChanges += records.length)).observe(el, {
        attributes: true,
        attributeFilter: ['data-corner', 'hidden'],
      });
    });
    // A slow pan that carries row labels and cards across the bottom corners and back.
    const v = await box(canvas(page));
    const at = (fx: number, fy: number) => [v.x + v.width * fx, v.y + v.height * fy] as const;
    await page.mouse.move(...at(0.5, 0.3));
    await page.mouse.down();
    for (const [fx, fy] of [
      [0.3, 0.8],
      [0.7, 0.9],
      [0.5, 0.6],
      [0.2, 0.9],
      [0.6, 0.5],
    ] as const) {
      await page.mouse.move(...at(fx, fy), { steps: 20 });
    }
    await page.mouse.up();
    await settled(page);
    await page.waitForTimeout(400);
    const changes = await page.evaluate(
      () => (window as unknown as { __cornerChanges: number }).__cornerChanges,
    );
    expect(changes).toBeLessThanOrEqual(1);
  });

  test('the minimap shows the viewport and navigates on click and drag', async ({ page }) => {
    await open(page);
    const minimap = page.getByRole('application', { name: 'Minimap' });
    await expect(minimap).toBeVisible();
    // The minimap may change corners once the view rests (150ms): measure it after.
    const rested = async () => {
      await minimapRested(page);
      return box(minimap);
    };
    let m = await rested();
    const start = await transform(page);
    await page.mouse.click(m.x + 10, m.y + 10);
    await expect.poll(async () => (await transform(page)).x).not.toBe(start.x);
    await settled(page);
    m = await rested();
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
    // Keyboard focus lands on the new focus card, so arrows and shortcuts keep working.
    await expect(card(page, 'Tilda Hale')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    expect([ids.piers, ids.rhea]).toContain(await activeKey(page));
    await page.keyboard.press('f');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  });

  test('picking a Find result with the keyboard focuses the new focus card', async ({ page }) => {
    await open(page);
    await card(page, 'Ada Vale').focus();
    await page.keyboard.press('f');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.type('Otto');
    await expect(
      page
        .getByRole('dialog', { name: 'Command palette' })
        .getByRole('option', { name: /Otto Vale/ }),
    ).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.otto}\\?`));
    await expect(card(page, 'Otto Vale')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    expect([ids.bram, ids.fenn]).toContain(await activeKey(page));
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

  test('an id that cannot exist shows Person not found (#143)', async ({ page }) => {
    await page.goto(`/tree/x'y?tree=${encodeURIComponent(tree)}`);
    await expect(page.getByRole('heading', { name: 'Person not found' })).toBeVisible();
    await expect(page.getByText('Could not load the tree')).toHaveCount(0);
  });

  test('a person with no tree data shows an empty state', async ({ page }) => {
    await page.goto(`/tree/nobody?tree=${encodeURIComponent(tree)}`);
    await expect(page.getByRole('heading', { name: 'Person not found' })).toBeVisible();
    await page.getByRole('link', { name: 'Go to the home person' }).click();
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.ada}\\?`));
  });

  test('switching trees from the top bar opens the new tree at its home person', async ({
    page,
  }) => {
    await open(page);
    const switcher = page.getByRole('banner').getByRole('button', { name: /Tree:/ });
    await expect(switcher).toContainText(tree);
    await switcher.click();
    await page.getByRole('menuitemradio', { name: seed.perf.tree }).click();
    await expect(page).toHaveURL(new RegExp(`/tree/${seed.perf.focusId}\\?`));
    await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
    await expect(card(page, 'Ada Vale')).toHaveCount(0);
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

test.describe('pedigree, descendant and fan views', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** True when the locator's box lies inside the tree canvas. */
  async function inView(page: Page, locator: Locator) {
    const view = await box(canvas(page));
    const b = await box(locator);
    return (
      b.x >= view.x - 1 &&
      b.y >= view.y - 1 &&
      b.x + b.width <= view.x + view.width + 1 &&
      b.y + b.height <= view.y + view.height + 1
    );
  }

  test('the pedigree opens with the focus person at the left and every generation on screen', async ({
    page,
  }) => {
    await open(page, 'ada', '&layout=pedigree');
    await settled(page);
    const view = await box(canvas(page));
    const ada = await box(card(page, 'Ada Vale'));
    expect(ada.x - view.x).toBeLessThan(view.width / 4);
    // Compact cards, so four generations of ancestors fit.
    expect(ada.width).toBeLessThan(100);
    for (const name of ['Bram Vale', 'Elsa Hale', 'Otto Vale', 'Abel Vale', 'Lena Frost']) {
      expect(await inView(page, card(page, name).first())).toBe(true);
    }
    // Column heads never run into each other.
    const heads = [];
    for (const text of [
      /^Ada.s parents$/,
      /^Ada.s grandparents$/,
      /^Ada.s great-grandparents$/,
      /^Ada.s 2nd great-grandparents$/,
    ]) {
      heads.push(await box(world(page).getByText(text).first()));
    }
    for (let i = 1; i < heads.length; i++) {
      expect(heads[i]!.x).toBeGreaterThanOrEqual(heads[i - 1]!.x + heads[i - 1]!.width);
    }
  });

  test('the descendant chart opens with the focus person near the top', async ({ page }) => {
    await open(page, 'bram', '&layout=descendants');
    await settled(page);
    const view = await box(canvas(page));
    const bram = await box(card(page, 'Bram Vale'));
    expect(bram.y - view.y).toBeLessThan(view.height / 4);
    for (const name of ['Hugo Vale', 'Ada Vale', 'Ilsa Vale', 'Wren Ash']) {
      expect(await inView(page, card(page, name))).toBe(true);
    }
  });

  test('row labels move clear of cards when a wide row slides under them', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await open(page, 'bram', '&layout=descendants');
    await settled(page);
    const intersects = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const labels = page.getByTestId('tree-row-label');
    const cards = canvas(page).getByRole('button', { name: /, (male|female)/ });
    // Pan right so the rows run under the label column, then check every pair.
    for (const dx of [0, 300]) {
      if (dx) {
        await page.mouse.move(600, 400);
        await page.mouse.down();
        await page.mouse.move(600 + dx, 400, { steps: 5 });
        await page.mouse.up();
        await settled(page);
      }
      const labelBoxes = [];
      for (const label of await labels.all())
        if (await label.isVisible()) labelBoxes.push(await box(label));
      expect(labelBoxes.length).toBeGreaterThan(0);
      for (const card of await cards.all()) {
        const c = await card.boundingBox();
        if (!c) continue;
        for (const l of labelBoxes) expect(intersects(l, c)).toBe(false);
      }
    }
  });

  test('the fan chart fits the screen and marks unknown parents as empty slots', async ({
    page,
  }) => {
    await open(page, 'ada', '&layout=fan');
    await settled(page);
    const fan = page.getByTestId('tree-fan');
    expect(await inView(page, fan)).toBe(true);
    // Its segments stay buttons inside a labelled group (an img role would flatten them).
    await expect(page.getByRole('group', { name: 'Fan chart' })).toBeVisible();
    await expect(
      page.getByRole('group', { name: 'Fan chart' }).getByRole('button', { name: /^Bram Vale/ }),
    ).toBeVisible();
    // Rhea Lund's parents are unknown: their two slots are drawn empty, not left as a gap.
    const empty = page.getByTestId('fan-empty-slot');
    await expect(empty).not.toHaveCount(0);
    await expect(empty.first()).toHaveAttribute('aria-hidden', 'true');
  });
});

test.describe('hand-edited layouts (#146)', () => {
  for (const layout of ['bogus', 'descendant', 'toString', '__proto__']) {
    test(`layout=${layout} opens the family view`, async ({ page }) => {
      await open(page, 'ada', `&layout=${layout}`);
      await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
      await expect(page.getByText('Could not load the tree')).toHaveCount(0);
      await expect(card(page, 'Ada Vale')).toBeAttached();
      await expect(
        page.getByRole('toolbar', { name: 'Tree tools' }).getByRole('button', { name: /Layout/ }),
      ).toHaveAccessibleName('Layout: Family view');
    });
  }
});

test.describe('generation depth in the URL', () => {
  /** The `up` and `down` of every neighborhood request the page makes. */
  function depths(page: Page) {
    const seen: { up: number; down: number }[] = [];
    page.on('request', (r) => {
      const url = new URL(r.url());
      if (!url.pathname.startsWith('/api/') || !url.pathname.endsWith('/neighborhood')) return;
      seen.push({
        up: Number(url.searchParams.get('up')),
        down: Number(url.searchParams.get('down')),
      });
    });
    return seen;
  }

  for (const layout of ['family', 'pedigree', 'fan']) {
    test(`up=10 (the maximum) renders the ${layout} view`, async ({ page }) => {
      const seen = depths(page);
      await open(page, 'ada', `&layout=${layout}&up=10&down=10`);
      await expect(page.getByText('Could not load the tree')).toHaveCount(0);
      const focus =
        layout === 'fan'
          ? canvas(page).getByRole('button', { name: /^Ada Vale/ })
          : card(page, 'Ada Vale');
      await expect(focus).toBeAttached();
      expect(seen.length).toBeGreaterThan(0);
      for (const { up, down } of seen) {
        expect(up).toBeLessThanOrEqual(10);
        expect(down).toBeLessThanOrEqual(10);
      }
    });
  }

  test('the fan caps its rings and offers the pedigree for deeper', async ({ page }) => {
    const seen = depths(page);
    await open(page, 'ada', '&layout=fan&up=10');
    await expect(canvas(page).getByRole('button', { name: /^Ada Vale/ })).toBeAttached();
    // Six generations up (seven rings with the focus), plus one prefetched.
    expect(seen.length).toBeGreaterThan(0);
    for (const { up } of seen) expect(up).toBeLessThanOrEqual(7);
    const note = page.getByRole('status').filter({ hasText: 'The fan shows 6 generations' });
    await expect(note).toBeVisible();
    await note.getByRole('link', { name: 'Open the pedigree' }).click();
    await expect(page).toHaveURL(/layout=pedigree/);
    await expect(page).toHaveURL(/up=10/);
    await expect(note).toHaveCount(0);
  });

  test('the fan within its cap shows no note', async ({ page }) => {
    await open(page, 'ada', '&layout=fan&up=6');
    await expect(canvas(page).getByRole('button', { name: /^Ada Vale/ })).toBeAttached();
    await expect(page.getByText('The fan shows 6 generations')).toHaveCount(0);
  });

  test('out-of-range depths clamp instead of failing', async ({ page }) => {
    const seen = depths(page);
    await open(page, 'ada', '&up=99&down=-4');
    await expect(page.getByText('Could not load the tree')).toHaveCount(0);
    await expect(card(page, 'Ada Vale')).toBeAttached();
    // 99 clamps to the maximum; a negative depth to none.
    expect(seen.length).toBeGreaterThan(0);
    for (const { up, down } of seen) {
      expect(up).toBeLessThanOrEqual(10);
      expect(down).toBeGreaterThanOrEqual(0);
    }
  });

  for (const value of ['abc', '', '%20']) {
    test(`a non-numeric depth (${JSON.stringify(value)}) falls back to the default`, async ({
      page,
    }) => {
      const seen = depths(page);
      await open(page, 'ada', `&up=${value}&down=${value}`);
      await expect(card(page, 'Ada Vale')).toBeAttached();
      // The family view's defaults are 3 up and 2 down, never 0.
      expect(seen.length).toBeGreaterThan(0);
      for (const { up, down } of seen) {
        expect(up).toBeGreaterThanOrEqual(3);
        expect(down).toBeGreaterThanOrEqual(2);
      }
    });
  }
});

test.describe('fan chart keyboard', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const segment = (page: Page, name: string) =>
    page.getByTestId('tree-fan').getByRole('button', { name: new RegExp(`^${name},`) });

  test('one tab stop, arrows by relationship, and focus follows a re-focus', async ({ page }) => {
    await open(page, 'ada', '&layout=fan');
    // The toolbar comes first in Tab order, as it does on screen.
    const layoutButton = page.getByRole('button', { name: /^Layout:/ });
    await layoutButton.focus();
    await page.keyboard.press('Tab');
    await expect(segment(page, 'Ada Vale')).toBeFocused();
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[data-testid="tree-fan"]')),
      ),
    ).toBe(false);
    await page.keyboard.press('Shift+Tab');
    await expect(segment(page, 'Ada Vale')).toBeFocused();
    await expect(page.getByTestId('tree-fan').locator('[tabindex="0"]')).toHaveCount(1);

    // Up is the father's side of the parent ring, down back toward the center.
    await page.keyboard.press('ArrowUp');
    await expect(segment(page, 'Bram Vale')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(segment(page, 'Otto Vale')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(segment(page, 'Bram Vale')).toBeFocused();
    // Along the ring.
    await page.keyboard.press('ArrowRight');
    await expect(segment(page, 'Elsa Hale')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(segment(page, 'Bram Vale')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(segment(page, 'Ada Vale')).toBeFocused();

    // Enter re-focuses; keyboard focus lands on the new center.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tree/${ids.bram}\\?.*layout=fan`));
    await expect(segment(page, 'Bram Vale')).toHaveAccessibleName(/focus person/);
    await expect(segment(page, 'Bram Vale')).toBeFocused();
  });
});

for (const [width, height] of [
  [320, 568],
  [390, 844],
  [568, 320],
  [680, 900],
  [844, 390],
] as const) {
  test.describe(`quick view at ${width}x${height}`, () => {
    test.use({ viewport: { width, height }, hasTouch: true });

    test('stays on screen, below the top bar, off its card, with reachable actions', async ({
      page,
    }) => {
      // Four cards, each opened, measured and closed.
      test.slow();
      await open(page);
      await settled(page);
      // The minimap picks its corner after the view settles; measure after that,
      // or a card clear of it now can be under it in the next fresh view.
      await minimapRested(page);
      const topBar = (await page.getByRole('banner').boundingBox())!;
      const top = topBar.y + topBar.height;
      const touchTargets = await page.evaluate(
        () => window.matchMedia('(pointer: coarse), (max-width: 640px)').matches,
      );
      // The leftmost, rightmost, topmost and bottommost cards fully on screen and
      // not under the toolbar or minimap.
      const onScreen = await page.evaluate(
        ({ top, width, height }) =>
          [...document.querySelectorAll<HTMLElement>('[role="application"] [data-key]')]
            .map((el) => ({ key: el.dataset.key!, b: el.getBoundingClientRect() }))
            .filter(({ key, b }) => {
              if (b.x < 0 || b.y < top || b.right > width || b.bottom > height) return false;
              const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
              return hit?.closest<HTMLElement>('[data-key]')?.dataset.key === key;
            })
            .map(({ key, b }) => ({ key, x: b.x, y: b.y })),
        { top, width, height },
      );
      expect(onScreen.length).toBeGreaterThanOrEqual(1);
      const by = (f: (o: (typeof onScreen)[number]) => number) =>
        [...onScreen].sort((a, b) => f(a) - f(b))[0]!.key;
      const picks = [
        ...new Set([by((o) => o.x), by((o) => -o.x), by((o) => o.y), by((o) => -o.y)]),
      ].map((key) => canvas(page).locator(`[data-key="${key}"]`));
      for (const [i, target] of picks.entries()) {
        // Each from a fresh view: closing with Escape returns keyboard focus to the
        // card, which may scroll the view to show it.
        if (i > 0) {
          await open(page);
          await settled(page);
          await minimapRested(page);
        }
        const name = (await target.getAttribute('aria-label'))!.split(',')[0]!;
        const cardBox = await box(target);
        await target.tap();
        const quick = page.getByRole('dialog', { name });
        await expect(quick).toBeVisible();
        // Let the positioning settle (it can take a frame or two after opening).
        let b = await box(quick);
        await expect
          .poll(async () => {
            const now = await box(quick);
            const same = now.x === b.x && now.y === b.y && now.height === b.height;
            b = now;
            return same;
          })
          .toBe(true);
        expect(b.x, name).toBeGreaterThanOrEqual(0);
        expect(b.y, name).toBeGreaterThanOrEqual(top);
        expect(b.x + b.width, name).toBeLessThanOrEqual(width);
        expect(b.y + b.height, name).toBeLessThanOrEqual(height);
        // It does not cover the card it describes.
        const overlap =
          b.x < cardBox.x + cardBox.width &&
          cardBox.x < b.x + b.width &&
          b.y < cardBox.y + cardBox.height &&
          cardBox.y < b.y + b.height;
        expect(
          overlap,
          `${name} covered by its quick view: ${JSON.stringify({ b, cardBox })}`,
        ).toBe(false);
        // The name stays in sight, not scrolled under the actions.
        const title = quick.getByText(name, { exact: true });
        const t = await box(title);
        const shown = await page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.textContent ?? '',
          { x: t.x + Math.min(t.width / 2, 20), y: t.y + t.height / 2 },
        );
        expect(shown, `${name} hidden in its quick view`).toBe(name);
        const actions = [
          quick.getByRole('link', { name: 'Profile' }),
          quick.getByRole('button', { name: 'Make focus' }),
          quick.getByRole('button', { name: 'Edit' }),
        ];
        // Initial focus is on the first action.
        await expect(actions[0]!).toBeFocused();
        for (const action of actions) {
          const a = await box(action);
          expect(a.x, name).toBeGreaterThanOrEqual(0);
          expect(a.y, name).toBeGreaterThanOrEqual(top);
          expect(a.x + a.width, name).toBeLessThanOrEqual(width);
          expect(a.y + a.height, name).toBeLessThanOrEqual(height);
          if (touchTargets) {
            expect(a.height).toBeGreaterThanOrEqual(44);
            expect(a.width).toBeGreaterThanOrEqual(44);
          }
        }
        await page.keyboard.press('Escape');
        await expect(quick).toHaveCount(0);
      }
    });
  });
}

test.describe('quick view above a bottom toolbar', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('keeps clear of the phone layout bottom bar', async ({ page }) => {
    await open(page);
    await settled(page);
    // Stand in for the phone toolbar: the layout publishes its height on the tree region.
    const bar = 120;
    await page.evaluate((height) => {
      document
        .querySelector<HTMLElement>('[data-tree-region]')!
        .style.setProperty('--oa-tree-bottom-bar', `${height}px`);
    }, bar);
    // Pan so Ada's card ends where the popover fits below it on the bare screen
    // but not above the bar.
    const ada = await box(card(page, 'Ada Vale'));
    const dy = 500 - (ada.y + ada.height);
    await page.mouse.move(200, 400);
    await page.mouse.down();
    await page.mouse.move(200, 400 + dy, { steps: 5 });
    await page.mouse.up();
    const lowest = ids.ada;
    expect(lowest).toBeTruthy();
    const target = canvas(page).locator(`[data-key="${lowest}"]`);
    const name = (await target.getAttribute('aria-label'))!.split(',')[0]!;
    await target.tap();
    const quick = page.getByRole('dialog', { name });
    await expect(quick).toBeVisible();
    await expect
      .poll(async () => (await box(quick)).y + (await box(quick)).height)
      .toBeLessThanOrEqual(844 - bar);
  });
});

test.describe('far zoom', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('re-focusing while cards are painted on the canvas raises no errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const { perf } = seed;
    await page.goto(`/tree/${perf.wideId}?tree=${encodeURIComponent(perf.tree)}&down=7&up=1`);
    await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Fit to screen' }).click();
    await settled(page);
    expect((await transform(page)).scale).toBeLessThan(0.35);
    await canvas(page).locator(`[data-key="${perf.wideId}"]`).focus();
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowDown', 'ArrowUp']) {
      await page.keyboard.press(key);
      const target = await activeKey(page);
      await page.keyboard.press('Enter');
      // Straight on to the next, while the previous re-focus tween is still
      // running its frames: that is where the painted layer redraws.
      await expect(page).toHaveURL(new RegExp(`/tree/${target}\\?`));
      await expect.poll(() => activeKey(page)).toBe(target);
    }
    await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
    await settled(page);
    expect(errors).toEqual([]);
  });
});

test.describe('step and adoptive kinship (#138)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const sample = seed.sample;
  const openSample = async (page: Page, given: string) => {
    await page.goto(`/tree/${sample.ids[given]}?tree=${encodeURIComponent(sample.tree)}`);
    await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
  };

  test('a stepfather and half-sister keep their words in either parent set', async ({ page }) => {
    await openSample(page, 'George');
    await expect(card(page, 'Iris Hollowell')).toHaveAccessibleName(
      /half-sister of George Eldermoor$/,
    );
    await canvas(page)
      .getByRole('button', { name: /^Switch parents of George Eldermoor/ })
      .click();
    await expect(card(page, 'Leopold Hollowell')).toHaveAccessibleName(
      /, stepfather of George Eldermoor$/,
    );
    await expect(card(page, 'Iris Hollowell')).toHaveAccessibleName(
      /, half-sister of George Eldermoor$/,
    );
  });

  test('adoptive parents are named as such', async ({ page }) => {
    await openSample(page, 'Peter');
    await expect(card(page, 'Harold Ashgrove')).toHaveAccessibleName(
      /, adoptive father of Peter Ashgrove$/,
    );
    await expect(card(page, 'Dorothy Ingleby')).toHaveAccessibleName(
      /, adoptive mother of Peter Ashgrove$/,
    );
    await expect(card(page, 'Thomas Ashgrove')).toHaveAccessibleName(
      /, adopted brother of Peter Ashgrove$/,
    );
  });
});

test.describe('wide descendant charts (#74)', () => {
  test.use({ viewport: { width: 900, height: 700 } });

  type Box = { x: number; y: number; width: number; height: number };
  const intersects = (a: Box, b: Box) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  async function visibleBoxes(locator: Locator) {
    const out: Box[] = [];
    for (const el of await locator.all()) {
      if (!(await el.isVisible())) continue;
      // Thin gaps fade a label out but keep it in the reading order.
      if ((await el.getAttribute('data-thin')) !== null) continue;
      const b = await el.boundingBox();
      if (b) out.push(b);
    }
    return out;
  }

  const labels = (page: Page) => page.getByTestId('tree-row-label');
  const cards = (page: Page) => canvas(page).getByRole('button', { name: /, (male|female)/ });

  async function expectLabelsClear(page: Page) {
    const cardBoxes = await visibleBoxes(cards(page));
    for (const l of await visibleBoxes(labels(page))) {
      for (const c of cardBoxes) expect(intersects(l, c)).toBe(false);
    }
  }

  async function drag(page: Page, dx: number, dy: number) {
    await page.mouse.move(450, 350);
    await page.mouse.down();
    await page.mouse.move(450 + dx, 350 + dy, { steps: 5 });
    await page.mouse.up();
    await settled(page);
  }

  test('row labels never cover a card, at fit, 100% and zoomed out', async ({ page }) => {
    await open(page, 'bram', '&layout=descendants');
    await settled(page);
    await expectLabelsClear(page);
    await drag(page, 300, 0);
    await expectLabelsClear(page);
    // 100%, then zoomed out to just above the canvas level of detail.
    await page.getByRole('button', { name: 'Fit to screen' }).click();
    await settled(page);
    while ((await transform(page)).scale < 1) {
      await page.getByRole('button', { name: 'Zoom in' }).click();
      await settled(page);
    }
    await drag(page, 250, 0);
    await expectLabelsClear(page);
    for (let i = 0; i < 4 && (await transform(page)).scale > 0.45; i++) {
      await page.getByRole('button', { name: 'Zoom out' }).click();
      await settled(page);
      await expectLabelsClear(page);
    }
    // Slide the rows under the gutter: their gaps are now thinner than a label,
    // which fades out but stays in the reading order.
    await drag(page, -200, 0);
    await expectLabelsClear(page);
    await expect(page.locator('[data-testid="tree-row-label"][data-thin]')).not.toHaveCount(0);
    await expect(page.locator('[data-testid="tree-row-label"][hidden]')).toHaveCount(0);
  });

  test('row labels stay clear of cards after the text size changes', async ({ page }) => {
    await open(page, 'bram', '&layout=descendants');
    await settled(page);
    await page.getByRole('button', { name: 'Fit to screen' }).click();
    await settled(page);
    while ((await transform(page)).scale < 1) {
      await page.getByRole('button', { name: 'Zoom in' }).click();
      await settled(page);
    }
    // Clear every row of its label, then slide left until one row reaches its
    // label and back one step: that label sits just beside its row.
    const above = page.locator('[data-testid="tree-row-label"][data-above]');
    for (let i = 0; i < 15 && (await above.count()) > 0; i++) await drag(page, 100, 0);
    await expect(above).toHaveCount(0);
    for (let i = 0; i < 100 && (await above.count()) === 0; i++) await drag(page, -8, 0);
    await expect(above).not.toHaveCount(0);
    await drag(page, 8, 0);
    await expect(above).toHaveCount(0);
    // Like a minimum font size setting or a late web font: the labels grow,
    // and now reach into their rows unless they move up into the gap.
    await labels(page).evaluateAll((els) => {
      for (const el of els.flatMap((l) => [...l.querySelectorAll<HTMLElement>('*')])) {
        el.style.fontSize = '26px';
      }
    });
    await drag(page, 6, 0);
    await expectLabelsClear(page);
  });

  test('the minimap moves or collapses rather than cover a label or the active card', async ({
    page,
  }) => {
    await open(page, 'bram', '&layout=descendants');
    await settled(page);
    const minimap = page.getByTestId('tree-minimap');
    // Shown at the start (bottom-left unless something is already there).
    await expect(minimap).toBeVisible();
    const check = async () => {
      const m = await visibleBoxes(minimap);
      if (!m.length) return; // collapsed
      for (const l of await visibleBoxes(labels(page))) expect(intersects(m[0]!, l)).toBe(false);
      const active = canvas(page).locator('[data-key][tabindex="0"]');
      for (const a of await visibleBoxes(active)) expect(intersects(m[0]!, a)).toBe(false);
    };
    // The minimap re-checks its corner 150ms after each pan settles.
    await expect(check).toPass({ timeout: 2000 });
    // Bring the focus card and the lowest rows down to the bottom-left corner:
    // the minimap gets out of the way.
    await drag(page, -150, 250);
    // The minimap re-checks its corner 150ms after each pan settles.
    await expect(check).toPass({ timeout: 2000 });
    await expect(minimap).not.toHaveAttribute('data-corner', 'left');
    await drag(page, 300, 0);
    // The minimap re-checks its corner 150ms after each pan settles.
    await expect(check).toPass({ timeout: 2000 });
  });
});

test.describe('fan labels (#137)', () => {
  const sample = seed.sample;
  async function openFan(page: Page) {
    await page.goto(`/tree/${sample.ids.Lily}?tree=${encodeURIComponent(sample.tree)}&layout=fan`);
    await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() => document.fonts.ready);
  }

  /** Each segment's label: its text, and whether all four corners lie in the segment. */
  function labels(page: Page) {
    return page.getByTestId('tree-fan').evaluate((svg) =>
      [...svg.querySelectorAll<SVGGElement>('g[role="button"]')].map((g) => {
        const text = g.querySelector('text');
        const path = g.querySelector('path')!;
        if (!text) return { text: null, inside: true, fontSize: 0 };
        const box = text.getBBox();
        const matrix = text.transform.baseVal.consolidate()?.matrix ?? new DOMMatrix();
        const corners = [
          [box.x, box.y],
          [box.x + box.width, box.y],
          [box.x, box.y + box.height],
          [box.x + box.width, box.y + box.height],
        ];
        return {
          text: [...text.querySelectorAll('tspan')].map((t) => t.textContent).join(' | '),
          inside: corners.every(([x, y]) =>
            path.isPointInFill(new DOMPoint(x, y).matrixTransform(matrix)),
          ),
          fontSize: parseFloat(getComputedStyle(text).fontSize),
        };
      }),
    );
  }

  test('names stay inside their segments, with years where they fit', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFan(page);
    const all = await labels(page);
    expect(all.filter((l) => !l.inside).map((l) => l.text)).toEqual([]);
    // Nearly every ancestor is named, and the inner rings with their years.
    expect(all.filter((l) => l.text).length).toBeGreaterThanOrEqual(all.length - 2);
    const withYears = all.filter((l) => l.text && /\d{4}/.test(l.text));
    expect(withYears.length).toBeGreaterThanOrEqual(3);
  });

  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    test(`hard names fit, whole, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const { tree, focusId } = seed.fanNames;
      await page.goto(`/tree/${focusId}?tree=${encodeURIComponent(tree)}&layout=fan`);
      await expect(canvas(page)).toHaveAttribute('aria-busy', 'false');
      await page.evaluate(() => document.fonts.ready);
      await page.getByRole('button', { name: 'Fit to screen' }).click();
      await settled(page);
      const all = await labels(page);
      expect(all.filter((l) => !l.inside).map((l) => l.text)).toEqual([]);
      const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      for (const l of all) expect(l.text ?? '').not.toMatch(lone);
      // The father's long name, in the widest ring, keeps his first name
      // (and at least the surname's initial), never initials alone.
      const father = all[1]!.text ?? '';
      expect(father).toMatch(/^Johann .*(v\.|von)/);
      // The single-word name is shown, whole or shortened, in every ring.
      expect(all.filter((l) => l.text?.startsWith('山田')).length).toBeGreaterThan(0);
    });
  }

  test('Fit on a phone keeps names readable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFan(page);
    await page.getByRole('button', { name: 'Fit to screen' }).click();
    await settled(page);
    const { scale } = await transform(page);
    const all = await labels(page);
    expect(all.filter((l) => !l.inside).map((l) => l.text)).toEqual([]);
    for (const l of all.filter((l) => l.text))
      expect(l.fontSize * scale).toBeGreaterThanOrEqual(10);
    // The focus person stays on screen.
    await expect(canvas(page).getByRole('button', { name: /^Lily Mosswood/ })).toBeInViewport();
  });
});

test.describe('visual snapshots', () => {
  // Baselines are Linux Chromium only, like design.spec.ts.
  test.skip(
    ({ browserName }) => browserName !== 'chromium' || process.platform !== 'linux',
    'Linux Chromium baselines only',
  );

  for (const zoom of ['fit', '100'] as const) {
    test(`wide descendant chart at ${zoom === 'fit' ? 'fit' : '100%'}`, async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 700 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page, 'bram', '&layout=descendants');
      await settled(page);
      if (zoom === '100') {
        while ((await transform(page)).scale < 1) {
          await page.getByRole('button', { name: 'Zoom in' }).click();
          await settled(page);
        }
      }
      await minimapRested(page);
      await page.evaluate(() => document.fonts.ready);
      await expect(canvas(page)).toHaveScreenshot(`tree-descendants-wide-${zoom}.png`);
    });
  }

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`family view canvas (${colorScheme})`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await open(page);
      await minimapRested(page);
      await page.evaluate(() => document.fonts.ready);
      await expect(canvas(page)).toHaveScreenshot(`tree-family-${colorScheme}.png`);
    });
  }
});
