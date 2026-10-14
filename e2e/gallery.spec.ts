import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { HOSTILE_URLS, MEDIA_IDS, MEDIA_TREE, PHOTO_TITLES, REMOTE_HOST } from './media-fixture';
import { expect, test } from './fixtures';

/*
 * Person Gallery tab (issue #17): thumbnails, Ancestry placeholders that are
 * never fetched, type filters, a keyboard lightbox, profile photo, attaching
 * files and a virtualized grid.
 */

async function openGallery(page: Page, personId = MEDIA_IDS.imogen) {
  // Runs after the fixture's own init script, so this tree wins.
  await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), MEDIA_TREE);
  await page.goto(`/person/${personId}?tab=gallery`);
  await expect(page.getByRole('tab', { name: 'Gallery', selected: true })).toBeVisible();
  return page.getByRole('region', { name: 'Gallery' });
}

const tile = (gallery: ReturnType<Page['getByRole']>, name: string | RegExp) =>
  gallery.getByRole('button', { name });

test('shows local thumbnails and Ancestry placeholders without fetching them', async ({ page }) => {
  const remote: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === REMOTE_HOST) remote.push(request.url());
  });
  const gallery = await openGallery(page);
  for (const title of PHOTO_TITLES) {
    const image = tile(gallery, new RegExp(title)).locator('img');
    await expect(image).toHaveAttribute('src', /\/thumb\/sm$/);
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBeGreaterThan(0);
  }
  const placeholder = tile(gallery, /1911 census page/);
  await expect(placeholder).toContainText('On Ancestry');
  await expect(placeholder).toContainText('1911');
  await expect(placeholder.locator('img')).toHaveCount(0);
  await expect(tile(gallery, /Baptism record/)).toContainText('PDF');
  // Media on the person's events are included and say so.
  await expect(tile(gallery, /Christening portrait/)).toContainText('Birth');
  expect(remote).toEqual([]);
});

test('filters by type', async ({ page }) => {
  const gallery = await openGallery(page);
  const filters = page.getByRole('group', { name: 'Media type' });
  await filters.getByRole('button', { name: /Documents/ }).click();
  await expect(gallery.getByRole('button', { name: /Baptism record/ })).toBeVisible();
  await expect(gallery.getByRole('button', { name: /Wedding day/ })).toHaveCount(0);
  await filters.getByRole('button', { name: /On Ancestry/ }).click();
  await expect(gallery.getByRole('button', { name: /1911 census page/ })).toBeVisible();
  await expect(gallery.getByRole('button', { name: /Baptism record/ })).toHaveCount(0);
  await filters.getByRole('button', { name: /Photos/ }).click();
  await expect(gallery.getByRole('button', { name: /Wedding day/ })).toBeVisible();
  await expect(gallery.getByRole('button', { name: /1911 census page/ })).toHaveCount(0);
  await expect(filters.getByRole('button', { name: /Photos/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('lightbox moves with the arrow keys and sets the profile photo', async ({ page }) => {
  const gallery = await openGallery(page);
  await tile(gallery, new RegExp(PHOTO_TITLES[0]!)).click();
  const lightbox = page.getByRole('dialog');
  await expect(lightbox).toContainText(PHOTO_TITLES[0]!);
  await expect(lightbox.getByRole('img', { name: PHOTO_TITLES[0] })).toHaveAttribute(
    'src',
    /\/thumb\/lg$/,
  );
  await page.keyboard.press('ArrowRight');
  await expect(lightbox).toContainText(PHOTO_TITLES[1]!);
  await page.keyboard.press('ArrowRight');
  await expect(lightbox).toContainText(PHOTO_TITLES[2]!);
  await page.keyboard.press('ArrowLeft');
  await expect(lightbox).toContainText(PHOTO_TITLES[1]!);
  await expect(lightbox).toContainText(/2 of \d+/);

  await lightbox.getByRole('button', { name: 'Set as profile photo' }).click();
  await expect(lightbox.getByText('Profile photo')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox).toBeHidden();
  await expect(tile(gallery, new RegExp(PHOTO_TITLES[1]!))).toBeFocused();
  const header = page.getByTestId('person-header');
  await expect(header.getByRole('img').first()).toHaveAttribute(
    'src',
    new RegExp(`/media/${MEDIA_IDS.wedding}`),
  );
  // Put it back for other tests in the shared library.
  await tile(gallery, new RegExp(PHOTO_TITLES[0]!)).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Set as profile photo' }).click();
  await expect(page.getByRole('dialog').getByText('Profile photo')).toBeVisible();
});

test('placeholders in the lightbox link to Ancestry without loading anything', async ({ page }) => {
  const gallery = await openGallery(page);
  await tile(gallery, /1911 census page/).click();
  const lightbox = page.getByRole('dialog');
  await expect(lightbox).toContainText('0a1b2c3d-0000-4000-8000-000000000099');
  const link = lightbox.getByRole('link', { name: 'View on Ancestry' });
  await expect(link).toHaveAttribute('href', new RegExp(REMOTE_HOST));
  await expect(link).toHaveAttribute('rel', /noreferrer/);
  await expect(lightbox.locator('img')).toHaveCount(0);
});

test('attaches a file from disk to the person or an event, once per content', async ({
  page,
}, testInfo) => {
  const gallery = await openGallery(page);
  // Unique bytes per run, so dedupe is tested within this test only.
  const color = `#${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')}`;
  const bytes = await sharp({ create: { width: 300, height: 200, channels: 3, background: color } })
    .png()
    .toBuffer();
  const title = `Attached ${testInfo.project.name} ${Date.now() % 1e6}`;

  await page.getByRole('button', { name: 'Add media' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add media' });
  await dialog
    .getByLabel('File')
    .setInputFiles({ name: `${title}.png`, mimeType: 'image/png', buffer: bytes });
  await dialog.getByRole('button', { name: 'Attach' }).click();
  await expect(dialog).toBeHidden();
  await expect(tile(gallery, new RegExp(title)).locator('img')).toHaveAttribute('src', /thumb/);

  await page.getByRole('button', { name: 'Add media' }).click();
  await dialog
    .getByLabel('File')
    .setInputFiles({ name: 'again.png', mimeType: 'image/png', buffer: bytes });
  await dialog.getByRole('combobox', { name: 'Attach to' }).click();
  await page.getByRole('option', { name: 'Birth, 1898' }).click();
  await dialog.getByRole('button', { name: 'Attach' }).click();
  await expect(dialog).toBeHidden();
  await expect(tile(gallery, new RegExp(`${title}.*Birth`))).toBeVisible();

  const items = (await (
    await page.request.get(`/api/trees/${MEDIA_TREE}/people/${MEDIA_IDS.imogen}/media`)
  ).json()) as { items: { media: { title: string }; owners: { type: string }[] }[] };
  const ours = items.items.filter((i) => i.media.title === title);
  expect(ours).toHaveLength(1);
  expect(ours[0]!.owners.map((o) => o.type)).toEqual(['person', 'event']);
});

test('virtualizes a large gallery', async ({ page }) => {
  const gallery = await openGallery(page, MEDIA_IDS.many);
  await expect(gallery.getByRole('button', { name: /Placeholder 1\b/ })).toBeVisible();
  const rendered = await gallery.getByRole('button').count();
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(120);
  await page.keyboard.press('End');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(gallery.getByRole('button', { name: /Placeholder 400\b/ })).toBeVisible();
  expect(await gallery.getByRole('button').count()).toBeLessThan(120);
  await expect(gallery).toContainText('400 items');
});

test('never turns hostile imported URLs into links', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const gallery = await openGallery(page, MEDIA_IDS.hostile);
  for (let i = 1; i <= HOSTILE_URLS.length; i++) {
    await gallery.getByRole('button', { name: new RegExp(`Hostile link ${i}\\b`) }).click();
    const lightbox = page.getByRole('dialog');
    await expect(lightbox).toContainText(`Hostile link ${i}`);
    await expect(lightbox.getByRole('link', { name: 'View on Ancestry' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
  const hrefs = await page
    .locator('a[href]')
    .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
  for (const href of hrefs) expect(href).not.toMatch(/^(javascript|data|file):|evil\.example/i);
  expect(dialogs).toEqual([]);
});
