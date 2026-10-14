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
  test('loads the small thumbnail of a local primary photo, not the original', async ({ page }) => {
    const { media } = await watch(page, async () => {
      await openPerson(page, MEDIA_IDS.pia);
      const avatar = page.getByTestId('person-header').locator('img').first();
      await expect(avatar).toHaveAttribute('src', new RegExp(`/media/${MEDIA_IDS.mill}/thumb/sm$`));
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
