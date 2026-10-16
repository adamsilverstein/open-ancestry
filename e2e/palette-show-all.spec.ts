import { person, send, session, uniqueTreeName } from './edit-seed';
import { expect, test } from './fixtures';

/* The palette lists the first people by name and offers the rest (#280). */

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
const GIVEN = ['Walter', 'Edith', 'Josiah', 'Ruth', 'Daniel', 'Emily', 'Zebulon', 'Margaret'];
const MORE = ['Thomas', 'Ada', 'Caleb', 'Hester'];

test('shows the first matches in name order and offers all of them', async ({
  page,
  request,
  baseURL,
}, info) => {
  const s = await session(request, baseURL!);
  const tree = uniqueTreeName('palette', `${info.project.name} ${info.title}`);
  await send(request, s, 'post', '/api/trees', { name: tree });
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  for (const given of [...GIVEN, ...MORE]) {
    await send(request, s, 'post', `${base}/people`, person(given, 'Quillfeather', 'M', '1880'));
  }
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto('/');
  await expect(page.locator('html[data-shell-ready]')).toBeAttached();
  await page.keyboard.press(`${modKey}+k`);
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await dialog.getByRole('combobox').fill('quillfeather');
  const people = dialog.getByRole('group', { name: 'People' }).getByRole('option');
  await expect(people.first()).toHaveAccessibleName(/^Ada Quillfeather/);
  const all = dialog.getByRole('option', { name: 'Show all 12 people' });
  await expect(all).toBeVisible();
  await expect(people.filter({ hasText: 'Quillfeather' })).toHaveCount(8);
  // Name order, so whoever is missing is predictable: the first eight alphabetically.
  const names = await people.filter({ hasText: 'Quillfeather' }).allInnerTexts();
  const givens = names.map((n) => n.split(' ')[0]);
  expect(givens).toEqual([...givens].sort());

  await all.click();
  await expect(dialog).toBeVisible();
  await expect(people.filter({ hasText: 'Quillfeather' })).toHaveCount(12);
  await expect(dialog.getByRole('option', { name: /^Show all/ })).toHaveCount(0);
});

test('says it lists only the first 100 when more match', async ({
  page,
  request,
  baseURL,
}, info) => {
  const s = await session(request, baseURL!);
  const tree = uniqueTreeName('palette', `${info.project.name} ${info.title}`);
  await send(request, s, 'post', '/api/trees', { name: tree });
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  for (const given of GIVEN) {
    await send(request, s, 'post', `${base}/people`, person(given, 'Quillfeather', 'M', '1880'));
  }
  // As if the tree held far more Quillfeathers than the palette can list.
  await page.route('**/search?*', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { items: unknown[]; total: number };
    await route.fulfill({ response: res, json: { ...body, total: 1795 } });
  });
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree);
  await page.goto('/');
  await expect(page.locator('html[data-shell-ready]')).toBeAttached();
  await page.keyboard.press(`${modKey}+k`);
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await dialog.getByRole('combobox').fill('quillfeather');
  await expect(
    dialog.getByRole('option', { name: 'Show the first 100 of 1,795 people' }),
  ).toBeVisible();
});
