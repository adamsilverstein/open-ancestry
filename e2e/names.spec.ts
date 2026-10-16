import type { APIRequestContext, Page } from '@playwright/test';
import { openSeeded, seedTree } from './edit-seed';
import { expect, test } from './fixtures';

/* Names can't reorder the text around them (#190). */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });

/** Imports a GEDCOM through the API (imports are not refused, unlike edits) and returns the tree. */
async function importGedcom(request: APIRequestContext, baseURL: string, text: string) {
  const { token } = (await (await request.get('/api/session')).json()) as { token: string };
  const headers = { origin: new URL(baseURL).origin, 'x-oa-token': token };
  const started = await request.post('/api/import', {
    headers,
    multipart: {
      file: {
        name: `Bidi ${Date.now() % 1e6} ${Math.random().toString(36).slice(2, 6)}.ged`,
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(text),
      },
    },
  });
  const { jobId } = (await started.json()) as { jobId: string };
  await expect
    .poll(async () => (await (await request.get(`/api/jobs/${jobId}`)).json()).state)
    .toBe('completed');
  return ((await (await request.get(`/api/jobs/${jobId}`)).json()) as { tree: string }).tree;
}

test('an imported name with a right-to-left override still reads in order', async ({
  page,
  request,
  baseURL,
}) => {
  const tree = await importGedcom(
    request,
    baseURL!,
    [
      '0 HEAD',
      '1 GEDC',
      '2 VERS 5.5.1',
      '1 CHAR UTF-8',
      '0 @I1@ INDI',
      '1 NAME Evil‮ /Ashdown/',
      '1 BIRT',
      '2 DATE 1880',
      '1 FAMC @F1@',
      '0 @I2@ INDI',
      '1 NAME Edmund /Ashdown/',
      '1 FAMS @F1@',
      '0 @F1@ FAM',
      '1 HUSB @I2@',
      '1 CHIL @I1@',
      '0 TRLR',
      '',
    ].join('\n'),
  );
  const res = await request.get(`/api/trees/${encodeURIComponent(tree)}/search?q=edmund`);
  const edmund = ((await res.json()) as { items: { person: { id: string } }[] }).items[0]!.person
    .id;
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto(`/person/${edmund}`);
  await expect(h1(page)).toHaveText('Edmund Ashdown');
  // The child's line in Edmund's relationships keeps the surname and dates in order.
  const child = page
    .getByRole('region', { name: 'Relationships', exact: true })
    .getByRole('link', { name: /^Evil/ });
  await expect(child).toHaveText(/^Evil Ashdown/);
  await child.click();
  await expect(h1(page)).toHaveText('Evil Ashdown');
  // Names are isolated, so a right-to-left name cannot pull the text after it around.
  await expect(h1(page).locator('bdi')).toHaveCount(1);
  await expect(page.locator('[data-person-name]').first()).toHaveCSS('unicode-bidi', 'isolate');
});

test('editing an imported name with an override removes it, and says so', async ({
  page,
  request,
  baseURL,
}) => {
  const tree = await importGedcom(
    request,
    baseURL!,
    [
      '0 HEAD',
      '1 GEDC',
      '2 VERS 5.5.1',
      '1 CHAR UTF-8',
      '0 @I1@ INDI',
      '1 NAME Evil\u202e /Ashdown/',
      '0 TRLR',
      '',
    ].join('\n'),
  );
  const res = await request.get(`/api/trees/${encodeURIComponent(tree)}/search?q=ashdown`);
  const id = ((await res.json()) as { items: { person: { id: string } }[] }).items[0]!.person.id;
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto(`/person/${id}`);
  await page.getByRole('button', { name: 'Edit person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await expect(dialog.getByRole('status')).toContainText('invisible');
  await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Evelyn');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(h1(page)).toHaveText('Evelyn Ashdown');
  const detail = await request.get(`/api/trees/${encodeURIComponent(tree)}/people/${id}`);
  const stored = ((await detail.json()) as { names: { given: string }[] }).names[0]!.given;
  expect(stored).toBe('Evelyn');
});

test('saving a name with a text-direction override is refused', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seedTree(request, baseURL!, `${testInfo.project.name} ${testInfo.title}`);
  await openSeeded(page, seeded);
  await expect(h1(page)).toHaveText('Rowan Ashdown');
  await page.getByRole('button', { name: 'Edit person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Evil‮');
  await dialog.getByRole('button', { name: 'Save' }).click();
  // The dialog stays open with the server's reason, and nothing is saved.
  await expect(dialog.getByRole('alert')).toContainText('text direction');
  // Behind the open dialog the page is hidden from the accessibility tree.
  await expect(page.getByRole('heading', { level: 1, includeHidden: true })).toHaveText(
    'Rowan Ashdown',
  );
});
