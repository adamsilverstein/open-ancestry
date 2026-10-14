import { expect, test } from './fixtures';

/*
 * Issue #41: the strict CSP must not break the dialog scroll lock. The shell
 * gets a per-response style nonce, which the app hands to the dialog library.
 */

test('opening a dialog locks page scroll without CSP violations', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to apply/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  await page.goto('/');
  await expect(page.locator('html[data-shell-ready]')).toBeAttached();
  const overflow = () => page.evaluate(() => getComputedStyle(document.body).overflow);
  expect(await overflow()).not.toBe('hidden');

  await page.getByRole('banner').getByRole('button', { name: /^Find/ }).click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await expect.poll(overflow).toBe('hidden');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();
  await expect.poll(overflow).not.toBe('hidden');
  expect(violations).toEqual([]);
});

test('each page load gets a fresh style nonce; scripts stay self-only', async ({ request }) => {
  const nonces = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const res = await request.get('/');
    const csp = res.headers()['content-security-policy']!;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(await res.text()).toContain(`<meta name="csp-nonce" content="${nonce}">`);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toMatch(/script-src/);
    nonces.add(nonce!);
  }
  expect(nonces.size).toBe(3);
});
