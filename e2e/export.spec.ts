import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  await page.getByRole('option', { name: tree, exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: format, exact: true }).click();
  // Privatize starts on for trees with living people; set it explicitly either way.
  await dialog.getByRole('checkbox', { name: /^Privatize/ }).setChecked(privatize);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Export' }).click(),
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

/** WebKit on Linux replaces spaces in download names with underscores; the header is tested in the server. */
const sameFileName = (actual: string, expected: string) =>
  actual.replace(/_/g, ' ') === expected.replace(/_/g, ' ');

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
  expect(sameFileName(file.name, `${tree}.ged`)).toBe(true);
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
  expect(await reimport(file.bytes)).toEqual(['Bramwell', 'Private']);
});

test('exports a GEDZIP archive that re-imports', async ({ page, request, baseURL }, info) => {
  const tree = treeName(info.title, info.project.name);
  await seedTree(request, baseURL!, tree);
  const file = await exportFrom(page, tree, 'GEDZIP (GEDCOM 7 with media)');
  expect(sameFileName(file.name, `${tree}.gdz`)).toBe(true);
  expect(await reimport(file.bytes)).toEqual(['Adelind', 'Bramwell']);
});

test('JSON export is a full backup, so privatize is not offered', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Export/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export tree' });
  await dialog.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: 'JSON (full backup)' }).click();
  await expect(dialog.getByRole('checkbox', { name: /^Privatize/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'File' })).toBeFocused();
});

test('shows what an export could not carry over', async ({ page }, info) => {
  // An imported tree (written straight into the e2e library) whose person points at a
  // family that is not in the file: a GEDCOM 7 export cannot keep that line.
  const tree = treeName(info.title, info.project.name);
  const library = process.env.OA_E2E_LIBRARY!;
  await importGedcom(
    {
      bytes: [
        '0 HEAD',
        '1 GEDC',
        '2 VERS 5.5.1',
        '0 @I1@ INDI',
        '1 NAME Odile /Fernsby/',
        '1 FAMS @F99@',
        '0 TRLR',
        '',
      ].join('\n'),
    },
    { dir: join(library, `${tree}.oatree`), name: tree },
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Export/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export tree' });
  await dialog.getByRole('combobox', { name: 'Tree' }).click();
  await page.getByRole('option', { name: tree, exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: 'GEDCOM 7', exact: true }).click();
  // A full export: privatized, the person and so the warning would not be there.
  await dialog.getByRole('checkbox', { name: /^Privatize/ }).uncheck();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Export' }).click(),
  ]);
  expect(await reimport(await readFile((await download.path())!))).toEqual(['Odile']);
  const status = dialog.getByRole('status');
  await expect(status).toContainText('1 imported line could not be carried over');
  await expect(status).toContainText('@F99@ is not in the export');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'File' })).toBeFocused();
});

test('privatize starts on for a tree with living people and warns when turned off', async ({
  page,
  request,
  baseURL,
}, info) => {
  const tree = treeName(info.title, info.project.name);
  await seedTree(request, baseURL!, tree);
  await page.goto('/');
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Export/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export tree' });
  await dialog.getByRole('combobox', { name: 'Tree' }).click();
  await page.getByRole('option', { name: tree, exact: true }).click();
  const privatize = dialog.getByRole('checkbox', { name: /^Privatize/ });
  await expect(privatize).toBeChecked();
  await expect(dialog.getByRole('status')).toHaveCount(0);
  await privatize.uncheck();
  await expect(dialog.getByRole('status')).toHaveText(
    'This export includes everything about 1 person who may be living.',
  );
  await dialog.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: 'JSON (full backup)', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText(
    'JSON is a full backup: it includes everything about 1 person who may be living.',
  );
});

test('a privatized export hides a deceased person marked confidential', async ({
  request,
  baseURL,
}, info) => {
  const tree = treeName(info.title, info.project.name);
  const { token } = (await (await request.get('/api/session')).json()) as { token: string };
  const headers = { origin: baseURL!, 'x-oa-token': token };
  expect((await request.post('/api/trees', { headers, data: { name: tree } })).status()).toBe(201);
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  const res = await request.post(`${base}/people`, {
    headers,
    data: {
      sex: 'F',
      living: 'dead',
      privacy: 'confidential',
      names: [{ given: 'Confida', surname: 'Hushwell' }],
      events: [{ type: 'BIRT', date_text: '1860', place: 'Hushtown, Quietshire' }],
    },
  });
  expect(res.status()).toBe(201);
  for (const path of ['export.ged?privatize=true', 'export.ged?version=7&privatize=true']) {
    const text = await (await request.get(`${base}/${path}`)).text();
    for (const secret of ['Confida', 'Hushwell', '1860', 'Hushtown']) {
      expect(text, `${path} ${secret}`).not.toContain(secret);
    }
    expect(text).toContain('1 NAME Private');
  }
  const zip = Buffer.from(await (await request.get(`${base}/export.gdz?privatize=true`)).body());
  expect(await reimport(zip)).toEqual(['Private']);
});

test('privatize stays on until the tree is checked, and if the check fails', async ({
  page,
  request,
  baseURL,
}, info) => {
  const tree = treeName(info.title, info.project.name);
  await seedTree(request, baseURL!, tree);
  // Hold the tree detail (with its living count) to catch a quick click.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let fail = false;
  await page.route(`**/api/trees/${encodeURIComponent(tree)}`, async (route) => {
    await held;
    if (fail)
      await route.fulfill({
        status: 500,
        json: { error: { code: 'internal_error', message: 'x' } },
      });
    else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Export/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export tree' });
  await dialog.getByRole('combobox', { name: 'Tree' }).click();
  await page.getByRole('option', { name: tree, exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: /^Privatize/ })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Export' })).toBeDisabled();

  // A failed check keeps privatize on, says why, and lets the export go ahead privatized.
  fail = true;
  release();
  await expect(dialog.getByRole('status')).toContainText('Could not check this tree');
  await expect(dialog.getByRole('checkbox', { name: /^Privatize/ })).toBeChecked();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Export' }).click(),
  ]);
  const text = await readFile((await download.path())!, 'utf8');
  expect(text).not.toContain('Adelind');
  expect(text).toContain('Bramwell');
});
