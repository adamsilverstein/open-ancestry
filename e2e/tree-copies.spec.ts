import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { session, send, uniqueTreeName } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * Issue #193: a tree folder copied by hand keeps its tree name inside, so the
 * switcher must still tell the copy from the original, and open the copy.
 */

test('a copied tree folder shows as a distinct entry and opens the copy', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const library = process.env.OA_E2E_LIBRARY!;
  const name = uniqueTreeName('copy', testInfo.project.name);
  const s = await session(request, baseURL!);
  await send(request, s, 'post', '/api/trees', { name });
  const folder = `${name} backup`;
  cpSync(join(library, `${name}.oatree`), join(library, `${folder}.oatree`), { recursive: true });

  await page.goto('/');
  const switcher = page.getByRole('banner').getByRole('button', { name: /Tree:/ });
  await switcher.click();
  await expect(page.getByRole('menuitemradio', { name, exact: true })).toBeVisible();
  const copy = page.getByRole('menuitemradio', { name: `${name} (${folder})`, exact: true });
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(switcher).toHaveAccessibleName(`Tree: ${name} (${folder})`);
  const current = await page.evaluate(() => localStorage.getItem('oa-tree'));
  expect(current).toBe(folder);

  // Rename starts from the stored name, not the label with its folder.
  await switcher.click();
  await page.getByRole('menuitem', { name: 'Rename tree…' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename tree' });
  await expect(rename.getByLabel('Tree name')).toHaveValue(name);
  await rename.getByRole('button', { name: 'Cancel' }).click();
});
