import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestInfo } from '@playwright/test';
import { generateGedcom } from '../fixtures/generate';
import { expect, test } from './fixtures';

/*
 * Cancelling a running import from the progress page: the server aborts the
 * job, removes the empty tree it made for the upload and deletes the upload.
 */

const UPLOAD_PREFIX = 'oa-upload-';

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
  // Large enough to still be importing when Cancel is pressed.
  const ged = generateGedcom({ people: 60_000, seed: 9 }).replace(
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
  await expect(cancel).toBeVisible();
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
