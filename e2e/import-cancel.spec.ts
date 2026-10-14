import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { TestInfo } from '@playwright/test';
import { generateGedcom } from '../fixtures/generate';
import { expect, test } from './fixtures';

/*
 * Cancelling a running import from the progress page: the server aborts the
 * job, removes the empty tree it made for the upload and deletes the upload.
 */

const UPLOAD_PREFIX = 'oa-upload-';

// Large imports share one server that runs one import at a time with a short
// queue; keep this file's uploads one after another.
test.describe.configure({ mode: 'serial' });

/** The server's temp upload folders whose file contains `marker`. */
function uploadsContaining(marker: string): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith(UPLOAD_PREFIX))
    .filter((name) => {
      try {
        const dir = join(tmpdir(), name);
        return readdirSync(dir).some((file) =>
          readFileSync(join(dir, file)).subarray(0, 4096).toString('latin1').includes(marker),
        );
      } catch {
        return false;
      }
    });
}

const unique = (testInfo: TestInfo) =>
  `Cancel ${testInfo.project.name} ${testInfo.workerIndex}${testInfo.retry} ${Date.now() % 1e6}`;

test('cancels a running import: no tree left, upload removed', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const name = unique(testInfo);
  const marker = `cancel-${randomUUID()}`;
  // Large enough to still be mapping when Cancel is pressed, small enough not to stall the shared e2e server (imports still run on its event loop).
  const ged = generateGedcom({ people: 15_000, seed: 9 }).replace(
    '0 HEAD\n',
    `0 HEAD\n1 NOTE ${marker}\n`,
  );

  await page.goto('/');
  await page.getByLabel('Choose a GEDCOM or GEDZIP').setInputFiles({
    name: `${name}.ged`,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(ged),
  });
  await expect(page).toHaveURL(/\/import\//);
  const cancel = page.getByRole('button', { name: 'Cancel import' });
  await expect(cancel).toBeEnabled({ timeout: 60_000 });
  await expect.poll(() => uploadsContaining(marker).length).toBe(1);
  const trees = async () =>
    ((await (await request.get('/api/trees')).json()).trees as { id: string }[]).map((t) => t.id);
  expect(await trees()).toContain(name);

  await cancel.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import cancelled' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(`Nothing was imported from ${name}.ged.`)).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: /Notifications/ })
      .getByRole('listitem')
      .filter({ hasText: 'Import cancelled' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel import' })).toHaveCount(0);

  expect(await trees()).not.toContain(name);
  expect(uploadsContaining(marker)).toEqual([]);
  await expect(page.getByRole('banner').getByRole('button', { name: /Tree:/ })).not.toContainText(
    name,
  );
});

test('a cancel after the import starts saving gets 409 and the UI stays honest', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const name = unique(testInfo);
  await page.goto('/');
  await page.getByLabel('Choose a GEDCOM or GEDZIP').setInputFiles({
    name: `${name}.ged`,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(generateGedcom({ people: 5_000, seed: 5 })),
  });
  await expect(page).toHaveURL(/\/import\//);
  const jobId = page.url().split('/').at(-1)!;

  // Wait until the import is past its last abort check (finalize, commit or done).
  await expect
    .poll(
      async () => {
        const job = await (await request.get(`/api/jobs/${jobId}`)).json();
        return (
          job.state === 'completed' || ['finalize', 'commit', 'done'].includes(job.progress?.phase)
        );
      },
      { timeout: 60_000, intervals: [20] },
    )
    .toBe(true);
  const session = await (await request.get('/api/session')).json();
  const late = await request.delete(`/api/jobs/${jobId}`, {
    headers: { origin: new URL(page.url()).origin, 'x-oa-token': session.token },
  });
  expect(late.status()).toBe(409);

  await expect(page.getByRole('heading', { level: 1, name: 'Import complete' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('Import cancelled')).toHaveCount(0);
  const trees = ((await (await request.get('/api/trees')).json()).trees as { id: string }[]).map(
    (t) => t.id,
  );
  expect(trees).toContain(name);
});

test('Cancel is only offered while the import can still stop', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const name = unique(testInfo);
  await page.goto('/');
  await page.getByLabel('Choose a GEDCOM or GEDZIP').setInputFiles({
    name: `${name}.ged`,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(generateGedcom({ people: 8_000, seed: 6 })),
  });
  const cancel = page.getByRole('button', { name: 'Cancel import' });
  await expect(page.getByText(/Mapping records/)).toBeVisible({ timeout: 60_000 });
  await expect(cancel).toBeEnabled();
  await expect(page.getByRole('heading', { level: 1, name: 'Import complete' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(cancel).toHaveCount(0);
});

test('the cancelled page has its heading focused and no accessibility violations', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const name = unique(testInfo);
  await page.goto('/');
  await page.getByLabel('Choose a GEDCOM or GEDZIP').setInputFiles({
    name: `${name}.ged`,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(generateGedcom({ people: 15_000, seed: 7 })),
  });
  const cancel = page.getByRole('button', { name: 'Cancel import' });
  await expect(cancel).toBeEnabled({ timeout: 60_000 });
  await cancel.click();
  const heading = page.getByRole('heading', { level: 1, name: 'Import cancelled' });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  await expect(heading).toBeFocused();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
