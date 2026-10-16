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
  await expect(page.getByRole('menuitem', { name: /Re-import updated export/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByRole('menuitem', { name: /^Export/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByRole('menu')).toContainText('Import a GEDCOM first');
});

test('the keyboard reaches re-import and export, which say why they are off', async ({ page }) => {
  const file = page.getByRole('banner').getByRole('button', { name: 'File' });
  await expect(file).not.toHaveAttribute('aria-disabled', 'true');
  await file.focus();
  await page.keyboard.press('Enter');
  const reimport = page.getByRole('menuitem', { name: /Re-import updated export/ });
  const exporting = page.getByRole('menuitem', { name: /^Export/ });
  // Arrow keys stop on both (a disabled Radix item would be skipped)...
  await page.keyboard.press('ArrowDown');
  await expect(reimport).toBeFocused();
  await expect(reimport).toHaveAccessibleDescription(/need a tree/);
  await page.keyboard.press('ArrowDown');
  await expect(exporting).toBeFocused();
  await expect(exporting).toHaveAttribute('aria-disabled', 'true');
  await expect(exporting).toHaveAccessibleDescription(/need a tree/);
  // ...and choosing one does nothing.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Export tree' })).toHaveCount(0);
});

test('History says the tree list could not load instead of loading forever', async ({ page }) => {
  await page.route('**/api/trees', (route) => route.fulfill({ status: 500, json: {} }));
  await page.reload();
  await page.locator('html[data-shell-ready]').waitFor({ state: 'attached' });
  await page.getByRole('banner').getByRole('button', { name: 'History' }).click();
  const dialog = page.getByRole('dialog', { name: 'History' });
  await expect(dialog).toContainText('Could not load');
  await expect(dialog).not.toContainText('Loading');
});

test('History says no tree is open instead of loading forever', async ({ page }) => {
  await page.getByRole('banner').getByRole('button', { name: 'History' }).click();
  const dialog = page.getByRole('dialog', { name: 'History' });
  await expect(dialog).toContainText('No tree is open');
  await expect(dialog).not.toContainText('Loading');
  await expect(dialog).not.toContainText('Every change to this tree');
  await expect(dialog.getByRole('button', { name: 'Undo' })).toBeDisabled();
});
