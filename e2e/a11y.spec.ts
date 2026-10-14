import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

const routes = [
  { path: '/', heading: 'Import your Ancestry GEDCOM' },
  { path: '/design', heading: 'Design system' },
  { path: '/tree/I1', heading: 'Family tree' },
  { path: '/person/I1', heading: 'Person' },
  { path: '/no-such-page', heading: 'Page not found' },
];

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`axe in ${colorScheme} theme`, () => {
    test.use({ colorScheme });

    for (const { path, heading } of routes) {
      test(`${path} has no violations`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeAttached();
        await page.evaluate(() => document.fonts.ready);
        const results = await new AxeBuilder({ page }).analyze();
        expect(results.violations).toEqual([]);
      });
    }

    test('open command palette has no violations', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('banner').getByRole('button', { name: /^Find/ }).click();
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  });
}
