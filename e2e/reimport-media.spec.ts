import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { zipSync } from 'fflate';
import sharp from 'sharp';
import { openTree, type MediaRow } from '@open-ancestry/db';
import { importGedcom } from '../packages/import/src/index';
import { makeTempDir } from '../fixtures/temp-dir';
import { expect, test } from './fixtures';

/*
 * #75: a later export whose photo has other bytes. Changed only in the
 * export, the new file is offered ticked; changed in this tree too, it is an
 * unticked conflict. Once applied, the person's gallery shows the new image.
 */

const REPLACE = /Use the new export's file for Wren portrait/;
const RED = '#d02020';
const BLUE = '#2020d0';
const GREEN = '#20a020';

const solid = (background: string) =>
  sharp({ create: { width: 96, height: 96, channels: 3, background } })
    .png()
    .toBuffer();

/** An invented person with one photo, known by its Ancestry _OID across exports. */
const GED = [
  '0 HEAD',
  '1 GEDC',
  '2 VERS 5.5.1',
  '1 CHAR UTF-8',
  '0 @I1@ INDI',
  '1 NAME Wren /Halloway/',
  '1 SEX F',
  '1 BIRT',
  '2 DATE 4 APR 1872',
  '2 PLAC Brackenford, Westmere',
  '1 OBJE @O1@',
  '0 @O1@ OBJE',
  '1 FILE photos/wren.png',
  '2 TITL Wren portrait',
  '1 _OID 9101',
  '0 TRLR',
  '',
].join('\n');

const exportZip = async (color: string) =>
  Buffer.from(
    zipSync({
      'tree.ged': new TextEncoder().encode(GED),
      'photos/wren.png': await solid(color),
    }),
  );

const library = () =>
  process.env.OA_E2E_LIBRARY ?? join(tmpdir(), `oa-e2e-library-${process.env.E2E_PORT}`);

/**
 * Imports the first export (a red photo), lets `prepare` edit the tree, then
 * moves it into the e2e library. Built aside, so the server (which opens
 * every tree in the library to list it) never holds it while it is written.
 */
async function seed(label: string, prepare?: (dir: string) => Promise<void>) {
  const info = test.info();
  const name = `Reimport media ${label} ${info.project.name} ${info.workerIndex}${info.retry} ${Date.now() % 1e6}`;
  // In the OS temp dir beside the library, so the move into it is a rename.
  const staging = makeTempDir('oa-e2e-staging-');
  try {
    const built = join(staging, `${name}.oatree`);
    await importGedcom({ gedzip: await exportZip(RED) }, { dir: built, name });
    await prepare?.(built);
    const store = openTree(built);
    const person = store.db.prepare('SELECT id FROM person').pluck().get() as string;
    store.close();
    renameSync(built, join(library(), `${name}.oatree`));
    return { name, person };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The user's own replacement of the photo in this tree (a logged edit, not an import). */
async function replaceInTree(dir: string, color: string) {
  const bytes = await solid(color);
  mkdirSync(join(dir, 'media', 'photos'), { recursive: true });
  writeFileSync(join(dir, 'media', 'photos', 'mine.png'), bytes);
  const store = openTree(dir);
  const media = store.db.prepare('SELECT * FROM media').get() as MediaRow;
  store.transact('Replace photo', (tx) =>
    tx.update('media', media.id, {
      local_path: 'photos/mine.png',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byte_size: bytes.length,
    }),
  );
  store.close();
}

/** Re-imports from the File menu of the page already open (no reload). */
async function startReimport(page: Page, color: string) {
  await page.getByRole('button', { name: 'File' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Re-import updated export/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'Halloway 2026.zip',
    mimeType: 'application/zip',
    buffer: await exportZip(color),
  });
  await expect(
    page.getByRole('heading', { level: 1, name: 'Review the updated export' }),
  ).toBeVisible({ timeout: 30_000 });
  return page
    .getByRole('article', { name: 'Wren Halloway', exact: true })
    .getByRole('checkbox', { name: REPLACE });
}

/** The colour the page drew for an image, read from its centre pixel. */
async function shownColor(image: Locator): Promise<'red' | 'green' | 'blue'> {
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);
  const [r, g, b] = await image.evaluate((img: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(img, 0, 0);
    return [...context.getImageData(img.naturalWidth >> 1, img.naturalHeight >> 1, 1, 1).data];
  });
  return r! > g! && r! > b! ? 'red' : g! > b! ? 'green' : 'blue';
}

async function galleryPhoto(page: Page, person?: string) {
  if (person) await page.goto(`/person/${person}?tab=gallery`);
  await expect(page.getByRole('tab', { name: 'Gallery', selected: true })).toBeVisible();
  return page
    .getByRole('region', { name: 'Gallery' })
    .getByRole('button', { name: /Wren portrait/ })
    .locator('img');
}

async function apply(page: Page) {
  await page.getByRole('button', { name: /^Apply \d+ changes?$/ }).click();
  await expect(
    page
      .getByRole('region', { name: /Notifications/ })
      .getByRole('listitem')
      .filter({ hasText: /Applied \d+ change/ }),
  ).toBeVisible({ timeout: 30_000 });
}

test('a photo changed only in the export is offered ticked and shown once applied', async ({
  page,
}) => {
  const { name, person } = await seed('export');
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), name);
  // Seen first, so this document already holds the old thumbnail.
  expect(await shownColor(await galleryPhoto(page, person))).toBe('red');
  // Everything after this stays in the one page: no reload may clear the image cache.
  await page.evaluate(() => ((window as unknown as { stayed: boolean }).stayed = true));

  const replace = await startReimport(page, BLUE);
  await expect(replace).toBeChecked();
  await apply(page);

  // On to the person from the result page, inside the app, and to her gallery.
  await page
    .getByRole('region', { name: 'Re-import applied' })
    .getByRole('link', { name: 'Wren Halloway' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/person/${person}`));
  await page.getByRole('tab', { name: 'Gallery' }).click();
  const photo = await galleryPhoto(page);
  await expect.poll(() => shownColor(photo)).toBe('blue');
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
});

test('a photo changed in both is an unticked conflict, applied only when ticked', async ({
  page,
}) => {
  const { name, person } = await seed('both', (dir) => replaceInTree(dir, GREEN));
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), name);
  expect(await shownColor(await galleryPhoto(page, person))).toBe('green');

  const replace = await startReimport(page, BLUE);
  await expect(replace).not.toBeChecked();
  const row = page
    .getByRole('article', { name: 'Wren Halloway', exact: true })
    .getByRole('listitem')
    .filter({ has: page.getByRole('checkbox', { name: REPLACE }) });
  await expect(row).toContainText('Conflict');
  await expect(row).toContainText('Edited in this tree since the last import');
  await expect(page.getByRole('button', { name: 'Apply 0 changes' })).toBeDisabled();

  // Ticked, the export's photo replaces the tree's.
  await replace.check();
  await apply(page);
  await expect.poll(async () => shownColor(await galleryPhoto(page, person))).toBe('blue');
});
