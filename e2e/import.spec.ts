import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures';

/*
 * Import through the UI (issue #12): first-run empty state, file picker and
 * drag-and-drop, live progress, the import report, and opening the tree.
 * Tests share one library, so every tree name is unique per test and project.
 */

const sample = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'ancestry-sample.ged'));

const unique = (testInfo: TestInfo, label: string) =>
  `${label} ${testInfo.project.name} ${testInfo.workerIndex}${testInfo.retry} ${Date.now() % 1e6}`;

async function chooseFile(page: Page, name: string, buffer: Buffer) {
  await page.getByLabel('Choose a GEDCOM or GEDZIP').setInputFiles({
    name,
    mimeType: 'application/octet-stream',
    buffer,
  });
}

test('imports the Ancestry sample through the file picker and opens the tree', async ({
  page,
}, testInfo) => {
  const name = unique(testInfo, 'Sample');
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Import your Ancestry GEDCOM' }),
  ).toBeVisible();
  await chooseFile(page, `${name}.ged`, sample);

  await expect(page).toHaveURL(/\/import\//);
  const report = page.getByRole('region', { name: 'Import report' });
  await expect(page.getByRole('heading', { level: 1, name: 'Import complete' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(report.getByRole('group', { name: 'People' })).toContainText('26');
  await expect(report.getByRole('group', { name: 'Families' })).toContainText('10');
  await expect(report.getByRole('group', { name: 'Sources' })).toContainText('5');
  await expect(report.getByRole('group', { name: 'Media' })).toContainText('2');
  await expect(report.getByText('Every line of the file was mapped')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Warnings' }).getByText('No warnings'),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Unmapped tags' }).getByText('No unmapped tags'),
  ).toBeVisible();
  await expect(report.getByText('Ancestry.com Family Trees')).toBeVisible();

  await page.getByRole('link', { name: 'Open tree' }).click();
  await expect(page).toHaveURL(/\/tree\/[0-9A-Z]{26}$/);
  await expect(page.getByRole('banner').getByRole('button', { name: /Tree:/ })).toContainText(name);
});

test('shows warnings with line numbers and unmapped tags', async ({ page }, testInfo) => {
  const ged = [
    '0 HEAD',
    '1 GEDC',
    '2 VERS 5.5.1',
    '0 @I1@ INDI',
    '1 NAME Wren /Thistlewood/',
    '1 FAMC @F99@',
    '1 _SKYPEID wren.t',
    '0 TRLR',
    '',
  ].join('\n');
  await page.goto('/');
  await chooseFile(page, `${unique(testInfo, 'Warnings')}.ged`, Buffer.from(ged));
  await expect(page.getByRole('heading', { level: 1, name: 'Import complete' })).toBeVisible({
    timeout: 30_000,
  });
  const warnings = page.getByRole('region', { name: 'Warnings' });
  await expect(warnings.getByRole('row', { name: /Line 6/ })).toContainText('@F99@');
  const unmapped = page.getByRole('region', { name: 'Unmapped tags' });
  await expect(unmapped.getByRole('row', { name: /INDI\._SKYPEID/ })).toContainText(
    '1 _SKYPEID wren.t',
  );
});

test('accepts a dropped file', async ({ page }, testInfo) => {
  await page.goto('/');
  const zone = page.getByRole('region', { name: 'Import a file' });
  const name = `${unique(testInfo, 'Dropped')}.ged`;
  const data = await page.evaluateHandle(
    ({ text, fileName }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], fileName));
      return transfer;
    },
    { text: sample.toString('utf8'), fileName: name },
  );
  await zone.dispatchEvent('dragenter', { dataTransfer: data });
  await expect(zone).toHaveAttribute('data-dragging', 'true');
  await zone.dispatchEvent('drop', { dataTransfer: data });
  await expect(page.getByRole('heading', { level: 1, name: 'Import complete' })).toBeVisible({
    timeout: 30_000,
  });
});

test('refuses files that are not GEDCOM or GEDZIP', async ({ page }) => {
  await page.goto('/');
  await chooseFile(page, 'notes.txt', Buffer.from('hello'));
  await expect(page.getByRole('alert')).toContainText('Choose a .ged, .gedcom, .zip or .gdz file');
  await expect(page).toHaveURL(/\/$/);
});

test('reports a failed import and removes the empty tree', async ({ page }, testInfo) => {
  const name = unique(testInfo, 'Broken');
  await page.goto('/');
  await chooseFile(page, `${name}.ged`, Buffer.from('this is not a GEDCOM file\n'));
  await expect(page.getByRole('heading', { level: 1, name: 'Import failed' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('alert')).toContainText('does not look like GEDCOM');
  const trees = (await (await page.request.get('/api/trees')).json()) as {
    trees: { name: string }[];
  };
  expect(trees.trees.map((t) => t.name)).not.toContain(name);
});

test.describe('tree switcher', () => {
  test('creates, switches, renames and deletes trees', async ({ page }, testInfo) => {
    const first = unique(testInfo, 'First');
    const renamed = unique(testInfo, 'Renamed');
    await page.goto('/');
    const banner = page.getByRole('banner');
    const switcher = banner.getByRole('button', { name: /Tree:/ });

    await switcher.click();
    await page.getByRole('menuitem', { name: 'New tree…' }).click();
    const create = page.getByRole('dialog', { name: 'New tree' });
    await create.getByLabel('Tree name').fill(first);
    await create.getByRole('button', { name: 'Create tree' }).click();
    await expect(create).toBeHidden();
    await expect(switcher).toContainText(first);

    // A bad name is explained, not sent.
    await switcher.click();
    await page.getByRole('menuitem', { name: 'Rename tree…' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename tree' });
    await rename.getByLabel('Tree name').fill('bad/name');
    await rename.getByRole('button', { name: 'Rename' }).click();
    await expect(rename.getByText(/path separator/)).toBeVisible();
    await rename.getByLabel('Tree name').fill(renamed);
    await rename.getByRole('button', { name: 'Rename' }).click();
    await expect(rename).toBeHidden();
    await expect(switcher).toContainText(renamed);

    await switcher.click();
    await expect(page.getByRole('menuitemradio', { name: renamed })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.keyboard.press('Escape');

    await switcher.click();
    await page.getByRole('menuitem', { name: 'Delete tree…' }).click();
    const confirm = page.getByRole('dialog', { name: `Delete “${renamed}”?` });
    await expect(confirm).toContainText('.trash');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(switcher).toContainText(renamed);

    await switcher.click();
    await page.getByRole('menuitem', { name: 'Delete tree…' }).click();
    await page
      .getByRole('dialog', { name: `Delete “${renamed}”?` })
      .getByRole('button', { name: 'Delete tree' })
      .click();
    await expect(switcher).not.toContainText(renamed);
    const trees = (await (await page.request.get('/api/trees')).json()) as {
      trees: { name: string }[];
    };
    expect(trees.trees.map((t) => t.name)).not.toContain(renamed);
  });

  test('the tree menu scrolls when the library has more trees than fit', async ({
    page,
    baseURL,
  }, testInfo) => {
    const { token } = (await (await page.request.get('/api/session')).json()) as {
      token: string;
    };
    const origin = new URL(baseURL!).origin;
    const names = Array.from({ length: 16 }, (_, i) => unique(testInfo, `Many ${i}`));
    for (const name of names) {
      const res = await page.request.post('/api/trees', {
        data: { name },
        headers: { origin, 'x-oa-token': token },
      });
      expect(res.status()).toBe(201);
    }
    await page.setViewportSize({ width: 1024, height: 420 });
    await page.goto('/');
    const switcher = page.getByRole('banner').getByRole('button', { name: /Tree:/ });
    await switcher.click();
    const menu = page.getByRole('menu');
    // The menu stays on screen and scrolls, so every tree can be reached.
    const box = (await menu.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(420);
    expect(await menu.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
    const last = names.at(-1)!;
    await page.getByRole('menuitemradio', { name: last }).click();
    await expect(switcher).toContainText(last);
  });

  test('switching trees remembers the choice', async ({ page, baseURL }, testInfo) => {
    const a = unique(testInfo, 'Alpha');
    const b = unique(testInfo, 'Beta');
    const { token } = (await (await page.request.get('/api/session')).json()) as {
      token: string;
    };
    const origin = new URL(baseURL!).origin;
    for (const name of [a, b]) {
      const res = await page.request.post('/api/trees', {
        data: { name },
        headers: { origin, 'x-oa-token': token },
      });
      expect(res.status()).toBe(201);
    }
    await page.goto('/');
    const switcher = page.getByRole('banner').getByRole('button', { name: /Tree:/ });
    await switcher.click();
    await page.getByRole('menuitemradio', { name: b }).click();
    await expect(switcher).toContainText(b);
    // The choice is stored where the person and tree views read it. (A reload would
    // not prove it here: the e2e fixture re-selects the fixture tree on every load.)
    expect(await page.evaluate(() => localStorage.getItem('oa-tree'))).toBe(b);
    await page.getByRole('link', { name: 'open-ancestry home' }).click();
    await expect(switcher).toContainText(b);
    await switcher.click();
    await page.getByRole('menuitemradio', { name: a }).click();
    await expect(switcher).toContainText(a);
  });
});

test('File > Import GEDCOM opens the file picker from any page', async ({ page }) => {
  await page.goto('/design');
  await page.getByRole('button', { name: 'File' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Import GEDCOM/ }).click();
  await chooser;
});

test.describe('failed imports never delete data', () => {
  async function treeInfo(page: Page, name: string) {
    const res = await page.request.get(`/api/trees/${encodeURIComponent(name)}`);
    return res.ok() ? ((await res.json()) as { tree: { peopleCount: number } }).tree : null;
  }

  test('revisiting a failed job keeps a tree re-imported under the same name', async ({
    page,
  }, testInfo) => {
    const name = unique(testInfo, 'Redo');
    await page.goto('/');
    await chooseFile(page, `${name}.ged`, Buffer.from('not a gedcom\n'));
    await expect(page.getByRole('heading', { level: 1, name: 'Import failed' })).toBeVisible({
      timeout: 30_000,
    });
    const failedPage = page.url();
    expect(await treeInfo(page, name)).toBeNull();

    await page.goto('/');
    await chooseFile(page, `${name}.ged`, sample);
    await expect(page.getByRole('heading', { level: 1, name: 'Import complete' })).toBeVisible({
      timeout: 30_000,
    });
    expect((await treeInfo(page, name))?.peopleCount).toBe(26);

    await page.goto(failedPage);
    await expect(page.getByRole('heading', { level: 1, name: 'Import failed' })).toBeVisible();
    await page.goBack();
    await page.goForward();
    expect((await treeInfo(page, name))?.peopleCount).toBe(26);
  });

  test('a failure importing into a populated tree leaves it alone', async ({
    page,
    baseURL,
  }, testInfo) => {
    const name = unique(testInfo, 'Populated');
    await page.goto('/');
    await chooseFile(page, `${name}.ged`, sample);
    await expect(page.getByRole('heading', { level: 1, name: 'Import complete' })).toBeVisible({
      timeout: 30_000,
    });
    const { token } = (await (await page.request.get('/api/session')).json()) as {
      token: string;
    };
    const started = await page.request.post(`/api/trees/${encodeURIComponent(name)}/import`, {
      headers: { origin: new URL(baseURL!).origin, 'x-oa-token': token },
      multipart: {
        file: { name: 'again.ged', mimeType: 'application/octet-stream', buffer: sample },
      },
    });
    expect(started.status()).toBe(202);
    const { jobId } = (await started.json()) as { jobId: string };
    await page.goto(`/import/${jobId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Import failed' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('alert')).toContainText('new, empty tree');
    expect((await treeInfo(page, name))?.peopleCount).toBe(26);
  });
});

test('deleting the open tree goes home', async ({ page }, testInfo) => {
  const name = unique(testInfo, 'Doomed');
  await page.goto('/');
  await chooseFile(page, `${name}.ged`, sample);
  await page.getByRole('link', { name: 'Open tree' }).click({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/tree\//);
  const switcher = page.getByRole('banner').getByRole('button', { name: /Tree:/ });
  await expect(switcher).toContainText(name);
  await switcher.click();
  await page.getByRole('menuitem', { name: 'Delete tree…' }).click();
  await page
    .getByRole('dialog', { name: `Delete “${name}”?` })
    .getByRole('button', { name: 'Delete tree' })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expect(switcher).not.toContainText(name);
});
