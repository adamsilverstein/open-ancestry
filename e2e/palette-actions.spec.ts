import { expect, test } from './fixtures';

/*
 * Palette actions match only the start of their label or a whole keyword, and
 * rank below people, so typing part of a name and pressing Enter never runs an
 * action such as the theme toggle.
 */

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

test('typing "the" and Enter does not toggle the theme', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html[data-shell-ready]')).toBeAttached();
  const theme = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const before = await theme();
  await page.keyboard.press(`${modKey}+k`);
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await dialog.getByRole('combobox').fill('the');
  await expect(dialog.getByRole('option', { name: /Switch to/ })).toHaveCount(0);
  await expect(dialog.getByText('Searching…')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect(await theme()).toBe(before);

  // The label's start and whole keywords still find it.
  for (const query of ['switch', 'dark theme', 'light']) {
    await dialog.getByRole('combobox').fill(query);
    await expect(dialog.getByRole('option', { name: /Switch to/ })).toHaveCount(1);
  }
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect.poll(theme).not.toBe(before);
});
