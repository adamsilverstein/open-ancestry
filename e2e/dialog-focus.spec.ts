import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { openSeeded, seedTree, type SeededTree } from './edit-seed';
import { expect, test } from './fixtures';

/*
 * Keyboard focus around editing dialogs (#108) and the History panel (#110):
 * focus goes back to whatever opened a dialog, never to <body>.
 */

let seeded: SeededTree;

test.beforeEach(async ({ request, baseURL }, testInfo) => {
  seeded = await seedTree(request, baseURL!, `${testInfo.project.name} ${testInfo.title}`);
});

const timeline = (page: Page) => page.getByRole('region', { name: 'Timeline', exact: true });
const relationships = (page: Page) =>
  page.getByRole('region', { name: 'Relationships', exact: true });

/** Opens with the keyboard: focus the control, press Enter. */
async function openWithKeyboard(opener: Locator) {
  await opener.focus();
  await opener.press('Enter');
}

test.describe('focus returns to the opener', () => {
  test('Edit person: Escape, Cancel and Save', async ({ page }) => {
    await openSeeded(page, seeded);
    const opener = page.getByRole('button', { name: 'Edit person', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Edit person' });

    await openWithKeyboard(opener);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await openWithKeyboard(opener);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(opener).toBeFocused();

    await openWithKeyboard(opener);
    await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Rowan James');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rowan James Ashdown');
    await expect(opener).toBeFocused();
  });

  test('the command palette opened over Edit person gives focus back to the dialog', async ({
    page,
  }) => {
    // Escape from the palette must not leave focus on <body> just because the
    // dialog underneath is open: that dialog holds what opened the palette.
    await openSeeded(page, seeded);
    await openWithKeyboard(page.getByRole('button', { name: 'Edit person', exact: true }));
    const dialog = page.getByRole('dialog', { name: 'Edit person' });
    const given = dialog.getByRole('textbox', { name: 'Given names' }).first();
    await expect(given).toBeFocused();
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`);
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(given).toBeFocused();
  });

  test('Edit person opened with a mouse click returns focus to it', async ({ page }) => {
    // WebKit does not focus a clicked button and focuses the <main> landmark
    // (tabindex=-1) instead; that must not become the place focus returns to.
    await openSeeded(page, seeded);
    const opener = page.getByRole('button', { name: 'Edit person', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Edit person' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.locator('main')).not.toBeFocused();
  });

  test('Delete person confirm: Cancel returns to Delete person', async ({ page }) => {
    await openSeeded(page, seeded);
    await openWithKeyboard(page.getByRole('button', { name: 'Edit person', exact: true }));
    const dialog = page.getByRole('dialog', { name: 'Edit person' });
    const remove = dialog.getByRole('button', { name: 'Delete person' });
    await openWithKeyboard(remove);
    const confirm = page.getByRole('alertdialog', { name: 'Delete Rowan Ashdown?' });
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(remove).toBeFocused();
  });

  test('Add event and Edit event; a deleted event hands focus to Add event', async ({ page }) => {
    await openSeeded(page, seeded);
    const add = timeline(page).getByRole('button', { name: 'Add event' });
    await openWithKeyboard(add);
    const addDialog = page.getByRole('dialog', { name: 'Add event' });
    await addDialog.getByRole('textbox', { name: 'Date' }).fill('1905');
    await page.keyboard.press('Enter');
    await expect(addDialog).toBeHidden();
    await expect(add).toBeFocused();

    const editDeath = timeline(page).getByRole('button', { name: 'Edit Death' });
    await openWithKeyboard(editDeath);
    const editDialog = page.getByRole('dialog', { name: 'Edit event' });
    await expect(editDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editDeath).toBeFocused();

    await openWithKeyboard(editDeath);
    await editDialog.getByRole('button', { name: 'Delete event' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete event' }).click();
    await expect(editDeath).toHaveCount(0);
    await expect(add).toBeFocused();
  });

  test('Add relative from the Add family member menu: focus starts in Given names', async ({
    page,
  }) => {
    await openSeeded(page, seeded);
    const opener = relationships(page).getByRole('button', { name: 'Add family member' });
    await openWithKeyboard(opener);
    await page.getByRole('menuitem', { name: 'Add parent' }).press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Add parent' });
    await expect(dialog.getByRole('textbox', { name: 'Given names' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await openWithKeyboard(opener);
    await page.getByRole('menuitem', { name: 'Add child' }).press('Enter');
    const child = page.getByRole('dialog', { name: 'Add child' });
    await expect(child.getByRole('textbox', { name: 'Given names' })).toBeFocused();
    await page.keyboard.type('Tamsin');
    await page.keyboard.press('Enter');
    await expect(child).toBeHidden();
    await expect(relationships(page).getByRole('link', { name: /Tamsin/ })).toBeVisible({
      timeout: 15_000,
    });
    await expect(opener).toBeFocused();
  });

  test('History: Escape returns to the History button', async ({ page }) => {
    await openSeeded(page, seeded);
    const opener = page.getByRole('banner').getByRole('button', { name: 'History', exact: true });
    await openWithKeyboard(opener);
    const history = page.getByRole('dialog', { name: 'History' });
    await expect(history.getByRole('listitem').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(history).toBeHidden();
    await expect(opener).toBeFocused();
  });
});

test.describe('History panel keyboard access', () => {
  test('the change list is focusable, named and passes axe', async ({ page }) => {
    // Short enough that the seeded changes overflow the list.
    await page.setViewportSize({ width: 1024, height: 360 });
    await openSeeded(page, seeded);
    await page.getByRole('banner').getByRole('button', { name: 'History', exact: true }).click();
    const history = page.getByRole('dialog', { name: 'History' });
    const list = history.getByRole('list', { name: 'Changes' });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    await list.focus();
    await expect(list).toBeFocused();
    const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('axe with editing overlays open', () => {
  const overlays: { name: string; open: (page: Page) => Promise<Locator> }[] = [
    {
      name: 'Edit person',
      open: async (page) => {
        await page.getByRole('button', { name: 'Edit person', exact: true }).click();
        return page.getByRole('dialog', { name: 'Edit person' });
      },
    },
    {
      name: 'Add event',
      open: async (page) => {
        await timeline(page).getByRole('button', { name: 'Add event' }).click();
        return page.getByRole('dialog', { name: 'Add event' });
      },
    },
    {
      name: 'Add relative',
      open: async (page) => {
        await relationships(page).getByRole('button', { name: 'Add family member' }).click();
        await page.getByRole('menuitem', { name: 'Add sibling' }).click();
        return page.getByRole('dialog', { name: 'Add sibling' });
      },
    },
    {
      name: 'History',
      open: async (page) => {
        // Short enough that the seeded changes overflow the list.
        await page.setViewportSize({ width: 1024, height: 360 });
        await page
          .getByRole('banner')
          .getByRole('button', { name: 'History', exact: true })
          .click();
        const history = page.getByRole('dialog', { name: 'History' });
        await expect(history.getByRole('listitem').first()).toBeVisible();
        return history;
      },
    },
    {
      name: 'command palette',
      open: async (page) => {
        await page.getByRole('banner').getByRole('button', { name: /Find/ }).click();
        return page.getByRole('dialog', { name: 'Command palette' });
      },
    },
  ];

  for (const colorScheme of ['light', 'dark'] as const) {
    for (const overlay of overlays) {
      test(`${overlay.name} has no violations (${colorScheme})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme });
        await openSeeded(page, seeded);
        const dialog = await overlay.open(page);
        await expect(dialog).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const results = await new AxeBuilder({ page }).analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});

test('Escape on the Delete person confirm never closes Edit person', async ({ page }) => {
  await openSeeded(page, seeded);
  await page.getByRole('button', { name: 'Edit person', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  const given = dialog.getByRole('textbox', { name: 'Given names' }).first();
  await given.fill('Rowan Unsaved');
  for (let i = 0; i < 20; i++) {
    await dialog.getByRole('button', { name: 'Delete person' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete Rowan Ashdown?' });
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(given).toHaveValue('Rowan Unsaved');
  }
});
