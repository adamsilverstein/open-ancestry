import { seedTree } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * Issue #116: at phone width the open tree's name stays readable; People and
 * Find give up their text labels (kept as accessible names) to make room.
 */

test.use({ viewport: { width: 390, height: 844 } });

test('the top bar shows the tree name at 390px', async ({ page, request, baseURL }, testInfo) => {
  // No screenshot: Playwright injects a <style> to take one, which the CSP guard catches in WebKit.
  const { tree } = await seedTree(request, baseURL!, `${testInfo.project.name} phone`);
  await page.addInitScript((name) => localStorage.setItem('oa-tree', name), tree);
  await page.goto('/people');
  const banner = page.getByRole('banner');
  const switcher = banner.getByRole('button', { name: `Tree: ${tree}` });
  await expect(switcher).toBeVisible();

  // At least about ten characters of the name are visible, not "Q…".
  const name = switcher.locator('span').first();
  const width = await name.evaluate((el) => el.getBoundingClientRect().width);
  const charWidth = await name.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.font = getComputedStyle(el).font;
    probe.style.position = 'absolute';
    probe.textContent = 'abcdefghij';
    document.body.append(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return w;
  });
  expect(width).toBeGreaterThanOrEqual(charWidth);

  // The labels are still the controls' names, and nothing overflows the bar.
  await expect(banner.getByRole('link', { name: 'People' })).toBeVisible();
  await expect(banner.getByRole('button', { name: /^Find/ })).toBeVisible();
  // Icon-only controls get a tooltip and are square, like History.
  for (const control of [
    banner.getByRole('link', { name: 'People' }),
    banner.getByRole('button', { name: /^Find/ }),
  ]) {
    await expect(control).toHaveAttribute('title', /People|Find/);
    const box = (await control.boundingBox())!;
    expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1);
  }
  const overflow = await banner.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
