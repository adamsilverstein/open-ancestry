import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { createTree, families, persons } from '@open-ancestry/db';
import { FIXTURE_PEOPLE } from './tree-fixture';
import { openSeeded, seedTree } from './edit-seed';
import { expect, test } from './fixtures';
import { MEDIA_IDS, MEDIA_TREE } from './media-fixture';

const people = FIXTURE_PEOPLE;

const routes = [
  { path: '/', heading: 'Import your Ancestry GEDCOM' },
  { path: '/design', heading: 'Design system' },
  { path: '/tree/I1', heading: 'Family tree' },
  { path: `/person/${people.rowan}`, heading: 'Rowan Ashdown' },
  { path: `/person/${people.rowan}?tab=lifestory`, heading: 'Rowan Ashdown' },
  { path: `/person/${people.rowan}?tab=sources`, heading: 'Rowan Ashdown' },
  { path: '/person/01NOSUCHPERSON0000000000000', heading: 'Person not found' },
  { path: '/no-such-page', heading: 'Page not found' },
];

/**
 * A small invented family whose focus person, Ava, has every sibling group:
 * her mother Cora's second husband Dex brings a half-brother (Eli, Cora's
 * son), a stepbrother (Finn, Dex's son) and a foster brother (Gus).
 */
function siblingTree(name: string): string {
  const store = createTree(join(process.env.OA_E2E_LIBRARY!, `${name}.oatree`), { name });
  const ava = store.transact('seed', (tx) => {
    const person = (sex: 'M' | 'F', given: string) =>
      persons.create(tx, { sex, names: [{ given, surname: 'Quill' }] }).id;
    const [bram, cora, dex, ava, eli, finn, gus] = [
      person('M', 'Bram'),
      person('F', 'Cora'),
      person('M', 'Dex'),
      person('F', 'Ava'),
      person('M', 'Eli'),
      person('M', 'Finn'),
      person('M', 'Gus'),
    ];
    families.create(tx, { partner1_id: bram, partner2_id: cora, children: [{ child_id: ava }] });
    families.create(tx, {
      partner1_id: dex,
      partner2_id: cora,
      children: [
        { child_id: eli },
        { child_id: finn, partner1_rel: 'biological', partner2_rel: 'step' },
        { child_id: gus, partner1_rel: 'foster', partner2_rel: 'foster' },
      ],
    });
    return ava;
  }).result;
  store.close();
  return ava;
}

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

    test('half, step and foster sibling groups have no violations', async ({ page }, info) => {
      const name = `a11y siblings ${colorScheme} ${info.project.name} ${Date.now() % 1e6}`;
      const ava = siblingTree(name);
      await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), name);
      await page.goto(`/person/${ava}`);
      const family = page.getByRole('region', { name: 'Relationships', exact: true });
      for (const group of ['Half-siblings (1)', 'Step-siblings (1)', 'Foster siblings (1)']) {
        await expect(family.getByRole('button', { name: group })).toBeVisible();
      }
      await page.evaluate(() => document.fonts.ready);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });

    test('person gallery and lightbox have no violations', async ({ page }) => {
      await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), MEDIA_TREE);
      await page.goto(`/person/${MEDIA_IDS.imogen}?tab=gallery`);
      const gallery = page.getByRole('region', { name: 'Gallery' });
      await expect(gallery.getByRole('button', { name: /Wedding day/ })).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await gallery.getByRole('button', { name: /Wedding day/ }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });

    test('import report and tree switcher menu have no violations', async ({ page }, testInfo) => {
      await page.goto('/');
      const ged = '0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 FAMC @F9@\n1 _X y\n0 TRLR\n';
      await page.getByLabel('Choose a GEDCOM or GEDZIP').setInputFiles({
        name: `a11y ${colorScheme} ${testInfo.project.name} ${Date.now() % 1e6}.ged`,
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(ged),
      });
      await expect(page.getByRole('heading', { level: 1, name: 'Import complete' })).toBeVisible({
        timeout: 30_000,
      });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByRole('banner').getByRole('button', { name: /Tree:/ }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      // A modal menu hides the page behind it, so check the menu itself.
      // An ARIA menu keeps its items out of the tab order and moves focus with the arrow
      // keys, scrolling each item into view (import.spec.ts checks End reaches the last
      // tree). axe's Safari-only scrollable-region rule does not know that pattern, and the
      // menu only scrolls when parallel specs have filled the shared library with trees.
      // Rule: https://dequeuniversity.com/rules/axe/4.13/scrollable-region-focusable
      // Decision: https://github.com/adamsilverstein/open-ancestry/pull/94 (narrowed to this menu).
      const menu = await new AxeBuilder({ page })
        .include('[role="menu"]')
        .disableRules(['scrollable-region-focusable'])
        .analyze();
      expect(menu.violations).toEqual([]);
    });

    test('open export dialog has no violations', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'File' }).click();
      await page.getByRole('menuitem', { name: /Export/ }).click();
      await expect(page.getByRole('dialog', { name: 'Export tree' })).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });

    test('open command palette has no violations', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('banner').getByRole('button', { name: /^Find/ }).click();
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  });
}

test.describe('axe on edit dialogs', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`edit person, event, relative and history dialogs in ${colorScheme}`, async ({
      page,
      request,
      baseURL,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      const seeded = await seedTree(
        request,
        baseURL!,
        `a11y ${testInfo.project.name} ${colorScheme}`,
      );
      await openSeeded(page, seeded);
      const check = async () => {
        const results = await new AxeBuilder({ page }).analyze();
        expect(results.violations).toEqual([]);
      };

      await page.getByRole('button', { name: 'Edit person' }).click();
      await expect(page.getByRole('dialog', { name: 'Edit person' })).toBeVisible();
      await check();
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Edit Birth' }).click();
      const event = page.getByRole('dialog', { name: 'Edit event' });
      await event.getByRole('textbox', { name: 'Date' }).fill('05/06/1880');
      await expect(event.getByTestId('date-preview')).toContainText('day first');
      await check();
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Add family member' }).click();
      await page.getByRole('menuitem', { name: 'Add child' }).click();
      await expect(page.getByRole('dialog', { name: 'Add child' })).toBeVisible();
      await check();
      await page.keyboard.press('Escape');

      await page.getByRole('banner').getByRole('button', { name: 'History', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'History' })).toBeVisible();
      await check();
    });
  }
});
