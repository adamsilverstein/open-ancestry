import { expect, test } from './fixtures';

/* With no tree open, tree-only actions are off and say why (#280). */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('oa-tree', 'Nope'));
  await page.route('**/api/trees', (route) => route.fulfill({ json: { trees: [] } }));
  await page.goto('/');
  await page.locator('html[data-shell-ready]').waitFor({ state: 'attached' });
});

test('the File menu disables re-import and export and says a tree is needed', async ({ page }) => {
  const file = page.getByRole('banner').getByRole('button', { name: 'File' });
  await expect(file).not.toHaveAttribute('aria-disabled', 'true');
  await file.click();
  await expect(page.getByRole('menuitem', { name: /Import GEDCOM/ })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: /Re-import updated export/ })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: /^Export/ })).toBeDisabled();
  await expect(page.getByRole('menu')).toContainText('Import a GEDCOM first');
});

test('History says no tree is open instead of loading forever', async ({ page }) => {
  await page.getByRole('banner').getByRole('button', { name: 'History' }).click();
  const dialog = page.getByRole('dialog', { name: 'History' });
  await expect(dialog).toContainText('No tree is open');
  await expect(dialog).not.toContainText('Loading');
  await expect(dialog).not.toContainText('Every change to this tree');
  await expect(dialog.getByRole('button', { name: 'Undo' })).toBeDisabled();
});
