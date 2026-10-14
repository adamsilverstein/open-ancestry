import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';
import { openMemoryTree } from '../packages/db/src/index';
import { importGedcom } from '../packages/import/src/index';
import { expect, test } from './fixtures';

/*
 * Export from the File menu: the dialog downloads a file the importer reads
 * back, and privatize keeps living people out of it.
 */

async function seedTree(request: APIRequestContext, baseURL: string, name: string) {
  const { token } = (await (await request.get('/api/session')).json()) as { token: string };
  const headers = { origin: baseURL, 'x-oa-token': token };
  expect((await request.post('/api/trees', { headers, data: { name } })).status()).toBe(201);
  const base = `/api/trees/${encodeURIComponent(name)}`;
  const ada = (await (
    await request.post(`${base}/people`, {
      headers,
      data: {
        sex: 'F',
        living: 'living',
        names: [{ given: 'Adelind', surname: 'Quarry' }],
        events: [{ type: 'BIRT', date_text: '5 SEP 1981', place: 'Harlow, Essex, England' }],
      },
    })
  ).json()) as { person: { id: string } };
  const parent = await request.post(`${base}/people/${ada.person.id}/parents`, {
    headers,
    data: {
      person: {
        sex: 'M',
        living: 'dead',
        names: [{ given: 'Bramwell', surname: 'Quarry' }],
        events: [{ type: 'DEAT', date_text: '1960' }],
      },
    },
  });
  expect(parent.status()).toBe(201);
}

async function exportFrom(page: Page, tree: string, format: string, privatize = false) {
  await page.goto('/');
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Export/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export tree' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Tree' }).click();
  await page.getByRole('option', { name: tree }).click();
  await dialog.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: format }).click();
  if (privatize) await dialog.getByRole('checkbox', { name: 'Privatize living people' }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('link', { name: 'Export' }).click(),
  ]);
  await expect(dialog).toBeHidden();
  return { name: download.suggestedFilename(), bytes: await readFile((await download.path())!) };
}

async function reimport(bytes: Uint8Array) {
  const store = openMemoryTree();
  await importGedcom({ bytes }, store);
  const names = store.db.prepare('SELECT given FROM person_name ORDER BY given').pluck().all();
  store.close();
  return names;
}

const treeName = (title: string, project: string) =>
  `export ${project} ${title.replace(/[^\w ]/g, '')} ${Date.now()}`.slice(0, 100);

test('exports GEDCOM 7 that re-imports with everyone in it', async ({
  page,
  request,
  baseURL,
}, info) => {
  const tree = treeName(info.title, info.project.name);
  await seedTree(request, baseURL!, tree);
  const file = await exportFrom(page, tree, 'GEDCOM 7');
  expect(file.name).toBe(`${tree}.ged`);
  expect(new TextDecoder().decode(file.bytes)).toMatch(/^0 HEAD\n1 GEDC\n2 VERS 7\.0/);
  expect(await reimport(file.bytes)).toEqual(['Adelind', 'Bramwell']);
});

test('exports GEDCOM 5.5.1 with living people privatized', async ({
  page,
  request,
  baseURL,
}, info) => {
  const tree = treeName(info.title, info.project.name);
  await seedTree(request, baseURL!, tree);
  const file = await exportFrom(page, tree, 'GEDCOM 5.5.1 (Ancestry)', true);
  const text = new TextDecoder().decode(file.bytes);
  expect(text).toContain('2 VERS 5.5.1');
  for (const secret of ['Adelind', '1981', 'Harlow']) expect(text).not.toContain(secret);
  expect(await reimport(file.bytes)).toEqual(['Bramwell', null]);
});

test('exports a GEDZIP archive that re-imports', async ({ page, request, baseURL }, info) => {
  const tree = treeName(info.title, info.project.name);
  await seedTree(request, baseURL!, tree);
  const file = await exportFrom(page, tree, 'GEDZIP (GEDCOM 7 with media)');
  expect(file.name).toBe(`${tree}.gdz`);
  expect(await reimport(file.bytes)).toEqual(['Adelind', 'Bramwell']);
});

test('JSON export is a full backup, so privatize is not offered', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Export/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export tree' });
  await dialog.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: 'JSON (full backup)' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Privatize living people' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'File' })).toBeFocused();
});
