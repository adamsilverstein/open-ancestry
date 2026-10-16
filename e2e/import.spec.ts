import AxeBuilder from '@axe-core/playwright';
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
  // Issue #121: the facts a genealogist checks before opening the tree.
  await expect(report.getByRole('group', { name: 'Repositories' })).toContainText('1');
  await expect(report.getByRole('group', { name: 'Submitters' })).toContainText('1');
  await expect(report.getByRole('link', { name: 'Thaddeus Ashgrove' })).toHaveAttribute(
    'href',
    /\/person\/[0-9A-Z]{26}$/,
  );

  // A link styled as a button reads as a button: no underline (#280).
  await expect(page.getByRole('link', { name: 'Open tree' })).toHaveCSS(
    'text-decoration-line',
    'none',
  );
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

test('shows the GEDCOM version the importer assumed, and a failure is focused', async ({
  page,
}, testInfo) => {
  // No GEDC.VERS: the importer reads it as 5.5.1, and the report says so like the CLI.
  await page.goto('/');
  await chooseFile(
    page,
    `${unique(testInfo, 'NoVers')}.ged`,
    Buffer.from('0 HEAD\n0 @I1@ INDI\n0 TRLR\n'),
  );
  const done = page.getByRole('heading', { level: 1, name: 'Import complete' });
  await expect(done).toBeVisible({ timeout: 30_000 });
  await expect(done).toBeFocused();
  const report = page.getByRole('region', { name: 'Import report' });
  await expect(report.getByText('GEDCOM 5.5.1, utf-8')).toBeVisible();
  await expect(page.getByText(/ in 0\.0 s/)).toHaveCount(0);

  await page.goto('/');
  await chooseFile(
    page,
    `${unique(testInfo, 'NotGedcom')}.ged`,
    Buffer.from('hello, not a gedcom\n'),
  );
  const failed = page.getByRole('heading', { level: 1, name: 'Import failed' });
  await expect(failed).toBeVisible({ timeout: 30_000 });
  await expect(failed).toBeFocused();
});

test('refuses a file over the upload limit before sending it (issue #120)', async ({ page }) => {
  // A test-sized limit: the app reads the server's caps from /api/limits.
  await page.route('**/api/limits', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ importUpload: { gedcomBytes: 1024, archiveBytes: 4096 } }),
    }),
  );
  const uploads: string[] = [];
  page.on('request', (r) => r.url().includes('/api/import') && uploads.push(r.url()));
  await page.goto('/');
  await chooseFile(page, 'big.ged', Buffer.alloc(2048, 'x'));
  await expect(page.getByRole('alert')).toHaveText(
    'This file is 2 KB. GEDCOM files can be up to 1 KB.',
  );
  await chooseFile(page, 'photos.zip', Buffer.alloc(5000, 'x'));
  await expect(page.getByRole('alert')).toHaveText(
    'This file is 4.9 KB. GEDZIP files can be up to 4 KB.',
  );
  expect(uploads).toEqual([]);
  await expect(page).toHaveURL(/\/$/);
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

    // A bad name is explained, not sent; a blank one before any request (issue #123).
    await switcher.click();
    await page.getByRole('menuitem', { name: 'Rename tree…' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename tree' });
    const sent: string[] = [];
    page.on(
      'request',
      (r) => r.url().includes('/api/trees') && r.method() === 'PATCH' && sent.push(r.url()),
    );
    await rename.getByLabel('Tree name').fill('   ');
    await rename.getByRole('button', { name: 'Rename' }).click();
    await expect(rename.getByText('Enter a tree name')).toBeVisible();
    await expect(rename.getByLabel('Tree name')).toBeFocused();
    expect(sent).toEqual([]);
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
    // Keyboard users reach every tree: End moves focus to the last item and scrolls to it.
    await page.keyboard.press('End');
    const lastItem = page.getByRole('menuitemradio').last();
    await expect(lastItem).toBeFocused();
    await expect(lastItem).toBeInViewport();
    // So axe's Safari-only scrollable-region rule, which does not know the ARIA menu
    // pattern (items out of the tab order, arrow keys move focus), does not apply.
    // Rule: https://dequeuniversity.com/rules/axe/4.13/scrollable-region-focusable
    // Decision: https://github.com/adamsilverstein/open-ancestry/pull/94 (narrowed to this menu).
    const axe = await new AxeBuilder({ page })
      .include('[role="menu"]')
      .disableRules(['scrollable-region-focusable'])
      .analyze();
    expect(axe.violations).toEqual([]);
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

  test('an import into a populated tree is refused and leaves it alone', async ({
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
    // Refused before the upload is read (issue #98): the tree already has data.
    expect(started.status()).toBe(409);
    expect((await started.json()).error.message).toContain('new, empty tree');
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
