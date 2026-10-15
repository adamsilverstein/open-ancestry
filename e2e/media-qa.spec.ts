import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MEDIA_IDS, MEDIA_TREE, OTHER_REMOTE_HOST, PHOTO_TITLES } from './media-fixture';
import { expect, test } from './fixtures';

/*
 * Media QA fixes: avatar thumbnails (#126), gallery tile sizing (#127) and
 * honest labels for missing, refused and broken media (#131).
 */

async function openPerson(page: Page, personId: string, tab?: string) {
  await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), MEDIA_TREE);
  await page.goto(`/person/${personId}${tab ? `?tab=${tab}` : ''}`);
  await expect(page.getByTestId('person-header')).toBeVisible();
}

/** Media requests and console errors while `run` executes. */
async function watch(page: Page, run: () => Promise<void>) {
  const media: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/media/')) media.push(new URL(request.url()).pathname);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await run();
  return { media, errors };
}

test.describe('person header avatar (#126)', () => {
  test('loads a thumbnail of a local primary photo, not the original', async ({ page }) => {
    const { media } = await watch(page, async () => {
      await openPerson(page, MEDIA_IDS.pia);
      const avatar = page.getByTestId('person-header').locator('img').first();
      // 120px avatar, sharp on 2x screens: the 480px thumbnail, never the original.
      await expect(avatar).toHaveAttribute('src', new RegExp(`/media/${MEDIA_IDS.mill}/thumb/md$`));
      await expect
        .poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBeGreaterThan(0);
    });
    expect(media).not.toContain(`/api/trees/${MEDIA_TREE}/media/${MEDIA_IDS.mill}`);
  });

  for (const [who, id] of [
    ['only on Ancestry', MEDIA_IDS.rhoda],
    ['a missing file', MEDIA_IDS.mona],
  ] as const) {
    test(`requests nothing when the primary photo is ${who}`, async ({ page }) => {
      const { media, errors } = await watch(page, async () => {
        await openPerson(page, id);
        await expect(page.getByTestId('person-header').getByRole('heading')).toBeVisible();
        // Give any image request time to start.
        await page.waitForLoadState('networkidle');
      });
      expect(media).toEqual([]);
      expect(errors).toEqual([]);
      await expect(page.getByTestId('person-header').locator('img')).toHaveCount(0);
    });
  }
});

test.describe('tree cards and quick view', () => {
  async function openTree(page: Page, personId: string) {
    await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), MEDIA_TREE);
    await page.goto(`/tree/${personId}`);
  }

  test('request only thumbnails for a local primary photo', async ({ page }) => {
    const { media } = await watch(page, async () => {
      await openTree(page, MEDIA_IDS.pia);
      const card = page.getByRole('button', { name: /^Pia Portrait,/ });
      await expect(card.locator('img')).toHaveAttribute('src', /\/thumb\/sm$/);
      await card.click();
      const quick = page.getByRole('dialog', { name: 'Pia Portrait' });
      await expect(quick.locator('img').first()).toHaveAttribute('src', /\/thumb\//);
      await page.waitForLoadState('networkidle');
    });
    expect(media.length).toBeGreaterThan(0);
    for (const path of media) expect(path).toMatch(/\/thumb\/(sm|md|lg)$/);
  });

  for (const [who, id, name] of [
    ['only on Ancestry', MEDIA_IDS.rhoda, 'Rhoda Remote'],
    ['a missing file', MEDIA_IDS.mona, 'Mona Missing'],
  ] as const) {
    test(`request nothing when the primary photo is ${who}`, async ({ page }) => {
      const { media, errors } = await watch(page, async () => {
        await openTree(page, id);
        await page.getByRole('button', { name: new RegExp(`^${name},`) }).click();
        await expect(page.getByRole('dialog', { name })).toBeVisible();
        await page.waitForLoadState('networkidle');
      });
      expect(media).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
});

test.describe('gallery tiles (#127)', () => {
  test('portrait, square, tiny and wide thumbnails stay inside their preview box', async ({
    page,
  }) => {
    await openPerson(page, MEDIA_IDS.imogen, 'gallery');
    const gallery = page.getByRole('region', { name: 'Gallery' });
    for (const title of ['Wedding day', 'Christening portrait', 'Tiny scrap', 'Harvest 1922']) {
      const tile = gallery.getByRole('button', { name: new RegExp(title) });
      const image = tile.locator('img');
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBeGreaterThan(0);
      const box = (await image.boundingBox())!;
      const preview = (await image.locator('..').boundingBox())!;
      const caption = (await tile.getByText(title).boundingBox())!;
      const tileBox = (await tile.boundingBox())!;
      expect(box.y, title).toBeGreaterThanOrEqual(preview.y - 0.5);
      expect(box.y + box.height, title).toBeLessThanOrEqual(preview.y + preview.height + 0.5);
      expect(box.x + box.width, title).toBeLessThanOrEqual(preview.x + preview.width + 0.5);
      expect(caption.y, title).toBeGreaterThanOrEqual(preview.y + preview.height - 0.5);
      expect(caption.y + caption.height, title).toBeLessThanOrEqual(tileBox.y + tileBox.height);
      // Sharp on 2x screens: the browser may pick the 480px thumbnail.
      if (title !== 'Tiny scrap') {
        await expect(image).toHaveAttribute('srcset', /thumb\/sm 160w, .*thumb\/md 480w/);
      }
    }
    // A 300px original: the md thumbnail is 300px, and the srcset says so, so 2x screens
    // get it at its real size and nothing is swapped after it loads.
    for (const title of ['Medium scan', 'Medium, size unknown']) {
      const medium = gallery.getByRole('button', { name: new RegExp(title) }).locator('img');
      await expect
        .poll(() => medium.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBeGreaterThan(0);
      await expect(medium, title).toHaveAttribute('srcset', /thumb\/md \d+w/);
    }
    await expect(
      gallery.getByRole('button', { name: /Medium scan/ }).locator('img'),
    ).toHaveAttribute('srcset', /thumb\/sm 160w, .*thumb\/md 300w/);
    // A tiny image is shown at its own size, centered: not blown up to fill the box,
    // and not shrunk by a srcset that claims a 480px candidate.
    for (const title of ['Tiny scrap', 'Small, size unknown']) {
      const tiny = gallery.getByRole('button', { name: new RegExp(title) }).locator('img');
      expect(await tiny.evaluate((img) => getComputedStyle(img).objectFit)).toBe('scale-down');
      // Without a srcset its intrinsic size is its natural 40px, which scale-down keeps.
      await expect.poll(() => tiny.getAttribute('srcset')).toBeNull();
      await expect
        .poll(() => tiny.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBe(40);
    }
    const results = await new AxeBuilder({ page }).include('[aria-label="Gallery"]').analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('media labels (#131)', () => {
  test('only Ancestry media are labelled On Ancestry', async ({ page }) => {
    await openPerson(page, MEDIA_IDS.imogen, 'gallery');
    const gallery = page.getByRole('region', { name: 'Gallery' });
    const tile = (name: string) => gallery.getByRole('button', { name: new RegExp(name) });
    await expect(tile('1911 census page')).toContainText('On Ancestry');

    await expect(tile('Missing wedding photo')).toContainText('File missing');
    await expect(tile('Missing wedding photo')).not.toContainText('On Ancestry');

    await expect(tile('Evil remote')).toContainText('Online');
    await expect(tile('Evil remote')).not.toContainText('On Ancestry');

    const filters = page.getByRole('group', { name: 'Media type' });
    await filters.getByRole('button', { name: /Missing/ }).click();
    await expect(tile('Missing wedding photo')).toBeVisible();
    await expect(tile('1911 census page')).toHaveCount(0);
    // Ancestry and other hosts share the Online filter; the tiles tell them apart.
    await expect(filters.getByRole('button', { name: /Online/ })).toContainText('2');
    await filters.getByRole('button', { name: /Online/ }).click();
    await expect(tile('1911 census page')).toBeVisible();
    await expect(tile('Evil remote')).toBeVisible();
    await expect(tile('Missing wedding photo')).toHaveCount(0);

    await tile('Evil remote').click();
    const lightbox = page.getByRole('dialog');
    await expect(lightbox).toContainText('Online');
    await expect(lightbox.getByRole('link', { name: /Ancestry/ })).toHaveCount(0);
    await expect(lightbox).not.toContainText(OTHER_REMOTE_HOST);
  });

  test('a corrupt image falls back to a placeholder and cannot become the profile photo', async ({
    page,
  }) => {
    await openPerson(page, MEDIA_IDS.imogen, 'gallery');
    const gallery = page.getByRole('region', { name: 'Gallery' });
    const corrupt = gallery.getByRole('button', { name: /Corrupt scan/ });
    await expect(corrupt.locator('img')).toHaveCount(0);
    await expect(corrupt).toContainText('Image unavailable');
    await corrupt.click();
    const lightbox = page.getByRole('dialog');
    await expect(lightbox).toContainText('Corrupt scan');
    await expect(lightbox.locator('img')).toHaveCount(0);
    await expect(lightbox.getByRole('button', { name: 'Set as profile photo' })).toHaveCount(0);
    // A working photo still offers it.
    await page.keyboard.press('Escape');
    await gallery.getByRole('button', { name: new RegExp(PHOTO_TITLES[2]!) }).click();
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Set as profile photo' }),
    ).toBeVisible();
  });
});

test.describe('profile photo on the server', () => {
  test('refuses media with no local file or a file that is not a readable image', async ({
    request,
    baseURL,
  }) => {
    const { token } = (await (await request.get('/api/session')).json()) as { token: string };
    const headers = { origin: new URL(baseURL!).origin, 'x-oa-token': token };
    const set = (mediaId: string) =>
      request.patch(`/api/trees/${MEDIA_TREE}/people/${MEDIA_IDS.pia}`, {
        headers,
        data: { primary_media_id: mediaId },
      });
    for (const [mediaId, reason] of [
      // A symlink out of the media folder is not a file in this tree.
      [MEDIA_IDS.outside, /no file in this tree/],
      [MEDIA_IDS.census, /no file in this tree/],
      [MEDIA_IDS.missing, /no file in this tree/],
      [MEDIA_IDS.corrupt, /not a readable image/],
    ] as const) {
      const res = await set(mediaId);
      expect(res.status(), mediaId).toBe(409);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(reason);
    }
    // A real local photo is still accepted (and leaves Pia as the fixture had her).
    expect((await set(MEDIA_IDS.mill)).ok()).toBe(true);
  });
});
