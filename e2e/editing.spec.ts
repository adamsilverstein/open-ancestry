import type { Page } from '@playwright/test';
import { openSeeded, seedTree, type SeededTree } from './edit-seed';
import { expect, test } from './fixtures';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

let seeded: SeededTree;

test.beforeEach(async ({ request, baseURL }, testInfo) => {
  seeded = await seedTree(request, baseURL!, `${testInfo.project.name} ${testInfo.title}`);
});

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const timeline = (page: Page) => page.getByRole('region', { name: 'Timeline', exact: true });
const relationships = (page: Page) =>
  page.getByRole('region', { name: 'Relationships', exact: true });
const toasts = (page: Page) =>
  page.getByRole('region', { name: /Notifications/ }).getByRole('listitem');

async function editPerson(page: Page) {
  await page.getByRole('button', { name: 'Edit person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('person', () => {
  test('edits names, sex and living status, then undoes and redoes with the keyboard', async ({
    page,
  }) => {
    await openSeeded(page, seeded);
    await expect(h1(page)).toHaveText('Rowan Ashdown');

    let dialog = await editPerson(page);
    await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Rowan James');
    await dialog.getByRole('combobox', { name: 'Sex' }).click();
    await page.getByRole('option', { name: 'Unknown' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(h1(page)).toHaveText('Rowan James Ashdown');
    await expect(
      page.getByTestId('person-header').getByRole('img', { name: /sex unknown/ }),
    ).toBeVisible();

    // Add a second name of another type.
    dialog = await editPerson(page);
    await dialog.getByRole('button', { name: 'Add name' }).click();
    const second = dialog.getByRole('group', { name: 'Name 2' });
    await second.getByRole('combobox', { name: 'Name type' }).click();
    await page.getByRole('option', { name: 'Also known as' }).click();
    await second.getByRole('textbox', { name: 'Given names' }).fill('Ro');
    await second.getByRole('textbox', { name: 'Surname' }).fill('Ashe');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    dialog = await editPerson(page);
    await expect(
      dialog.getByRole('group', { name: 'Name 2' }).getByRole('textbox', { name: 'Surname' }),
    ).toHaveValue('Ashe');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Each dialog save is one undo step: the added name, then name and sex together.
    await page.keyboard.press(`${mod}+z`);
    await expect(
      toasts(page).filter({ hasText: 'Undid Edit person: Rowan James Ashdown' }),
    ).toBeVisible();
    dialog = await editPerson(page);
    await expect(dialog.getByRole('group', { name: 'Name 2' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.keyboard.press(`${mod}+z`);
    await expect(h1(page)).toHaveText('Rowan Ashdown');
    await expect(
      page.getByTestId('person-header').getByRole('img', { name: 'Rowan Ashdown, male' }),
    ).toBeVisible();
    await page.keyboard.press(`Shift+${mod}+z`);
    await expect(h1(page)).toHaveText('Rowan James Ashdown');
    await expect(
      page.getByTestId('person-header').getByRole('img', { name: /sex unknown/ }),
    ).toBeVisible();
  });

  test('undoing the creation of the person on screen leaves their page', async ({ page }) => {
    await openSeeded(page, seeded);
    await relationships(page).getByRole('button', { name: 'Add family member' }).click();
    await page.getByRole('menuitem', { name: 'Add sibling' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add sibling' });
    await dialog.getByRole('textbox', { name: 'Given names' }).fill('Tobias');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await relationships(page)
      .getByRole('link', { name: /Tobias/ })
      .click();
    await expect(h1(page)).toHaveText('Tobias');
    await page.keyboard.press(`${mod}+z`);
    await expect(page).toHaveURL(new RegExp(`/person/${seeded.rowan}$`));
    await expect(toasts(page).filter({ hasText: 'Tobias is no longer in the tree' })).toBeVisible();
  });

  test('Cmd/Ctrl-Z does nothing while a dialog is open', async ({ page }) => {
    await openSeeded(page, seeded);
    let dialog = await editPerson(page);
    // Focus starts in Given names, the field people edit most.
    await expect(dialog.getByRole('textbox', { name: 'Given names' }).first()).toBeFocused();
    await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Rowan James');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(h1(page)).toHaveText('Rowan James Ashdown');

    dialog = await editPerson(page);
    await dialog.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press(`${mod}+z`);
    await expect(dialog.getByRole('textbox', { name: 'Given names' }).first()).toHaveValue(
      'Rowan James',
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(toasts(page).filter({ hasText: 'Undid' })).toHaveCount(0);
    await expect(h1(page)).toHaveText('Rowan James Ashdown');
  });

  test('Cmd/Ctrl-Z does nothing while a menu is open', async ({ page }) => {
    await openSeeded(page, seeded);
    const dialog = await editPerson(page);
    await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Rowan James');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(h1(page)).toHaveText('Rowan James Ashdown');

    const menus = [
      {
        open: () => relationships(page).getByRole('button', { name: 'Add family member' }).click(),
        item: 'Add sibling',
      },
      {
        open: () => page.getByRole('banner').getByRole('button', { name: 'File' }).click(),
        item: /Import GEDCOM/,
      },
    ];
    for (const { open, item } of menus) {
      await open();
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: item })).toBeVisible();
      await page.keyboard.press(`${mod}+z`);
      // The menu keeps the keyboard and nothing is undone.
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(toasts(page).filter({ hasText: 'Undid' })).toHaveCount(0);
      await expect(h1(page)).toHaveText('Rowan James Ashdown');
    }

    // With the menus closed, the same keys undo.
    await page.keyboard.press(`${mod}+z`);
    await expect(h1(page)).toHaveText('Rowan Ashdown');
  });

  test('Cmd/Ctrl-Z does nothing while a select list is open', async ({ page }) => {
    await openSeeded(page, seeded);
    const dialog = await editPerson(page);
    await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Rowan James');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(h1(page)).toHaveText('Rowan James Ashdown');
    /** State of the latest change batch, straight from the server. */
    const latest = async () => {
      const res = await page.request.get(
        `/api/trees/${encodeURIComponent(seeded.tree)}/history?limit=1`,
      );
      const { items } = (await res.json()) as { items: { label: string; state: string }[] };
      return `${items[0]!.label}: ${items[0]!.state}`;
    };
    // The page can show the edit before the server has recorded it.
    await expect.poll(latest).toMatch(/^Edit person: .*applied$/);

    // A select outside any dialog: the people list's Sex filter.
    await page.getByRole('banner').getByRole('link', { name: 'People' }).click();
    await page.getByRole('combobox', { name: 'Sex' }).click();
    const listbox = page.getByRole('listbox');
    await expect(listbox.getByRole('option', { name: 'Female' })).toBeVisible();
    await page.keyboard.press(`${mod}+z`);
    await expect(listbox).toBeVisible();
    // An undo would have reached the server by now.
    await page.waitForTimeout(500);
    expect(await latest()).toMatch(/^Edit person: .*applied$/);
    await page.keyboard.press('Escape');
    await expect(listbox).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Sex' })).toBeFocused();

    // With no list open, the same keys undo.
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(latest).toMatch(/^Edit person: .*undone$/);
  });

  test('Cmd/Ctrl-Z inside a text field is left to the field', async ({ page }) => {
    await openSeeded(page, seeded);
    const dialog = await editPerson(page);
    const given = dialog.getByRole('textbox', { name: 'Given names' }).first();
    await given.fill('Rowanx');
    await given.press(`${mod}+z`);
    await expect(dialog).toBeVisible();
    await expect(toasts(page).filter({ hasText: 'Undid' })).toHaveCount(0);
  });

  test('marks a person living or deceased explicitly', async ({ page }) => {
    await openSeeded(page, seeded, seeded.wendell);
    const dialog = await editPerson(page);
    await dialog.getByRole('combobox', { name: 'Living status' }).click();
    await page.getByRole('option', { name: 'Living', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    const again = await editPerson(page);
    await expect(again.getByRole('combobox', { name: 'Living status' })).toHaveText(/Living/);
  });

  test('deletes a person after confirmation, and undo brings them back', async ({ page }) => {
    await openSeeded(page, seeded);
    const dialog = await editPerson(page);
    await dialog.getByRole('button', { name: 'Delete person' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete Rowan Ashdown?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await dialog.getByRole('button', { name: 'Delete person' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete person' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(toasts(page).filter({ hasText: 'Deleted Rowan Ashdown' })).toBeVisible();

    await page.keyboard.press(`${mod}+z`);
    await expect(
      toasts(page).filter({ hasText: 'Undid Delete person: Rowan Ashdown' }),
    ).toBeVisible();
    await page.goto(`/person/${seeded.rowan}`);
    await expect(h1(page)).toHaveText('Rowan Ashdown');
  });
});

test.describe('events', () => {
  test('adds an event with a live date preview', async ({ page }) => {
    await openSeeded(page, seeded);
    await timeline(page).getByRole('button', { name: 'Add event' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add event' });
    await dialog.getByRole('combobox', { name: 'Event type' }).click();
    await page.getByRole('option', { name: 'Residence' }).click();
    const date = dialog.getByRole('textbox', { name: 'Date' });

    await date.fill('abt 1900');
    await expect(dialog.getByTestId('date-preview')).toHaveText('abt. 1900 · about');
    await date.fill('05/06/1910');
    await expect(dialog.getByTestId('date-preview')).toContainText('6 May 1910');
    await expect(dialog.getByTestId('date-preview')).toContainText('could also be read day first');
    await date.fill('when the mill burned');
    await expect(dialog.getByTestId('date-preview')).toContainText('Not a recognized date');
    await date.fill('bet 1900 and 1905');
    await expect(dialog.getByTestId('date-preview')).toHaveText('bet. 1900 and 1905 · between');

    await dialog.getByRole('textbox', { name: 'Place' }).fill('Wexmoor, Westmere');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    const row = timeline(page).getByRole('listitem').filter({ hasText: 'Residence' });
    await expect(row).toContainText('bet. 1900 and 1905');
    await expect(row).toContainText('Wexmoor, Westmere');
  });

  test('edits and deletes an event', async ({ page }) => {
    await openSeeded(page, seeded);
    await timeline(page).getByRole('button', { name: 'Edit Death' }).click();
    let dialog = page.getByRole('dialog', { name: 'Edit event' });
    await expect(dialog.getByRole('textbox', { name: 'Date' })).toHaveValue('3 NOV 1950');
    await dialog.getByRole('textbox', { name: 'Date' }).fill('4 NOV 1950');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const death = timeline(page)
      .getByRole('listitem')
      .filter({ has: page.locator('[data-title]', { hasText: /^Death$/ }) });
    await expect(death).toContainText('4 Nov 1950');
    await expect(page.getByTestId('person-header')).toContainText('4 Nov 1950');

    await timeline(page).getByRole('button', { name: 'Edit Death' }).click();
    dialog = page.getByRole('dialog', { name: 'Edit event' });
    await dialog.getByRole('button', { name: 'Delete event' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete event' }).click();
    await expect(timeline(page).getByText('Death', { exact: true })).toHaveCount(0);
  });
});

test.describe('relationships', () => {
  async function addRelative(page: Page, item: string) {
    await relationships(page).getByRole('button', { name: 'Add family member' }).click();
    await page.getByRole('menuitem', { name: item }).click();
    const dialog = page.getByRole('dialog', { name: item });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('adds a new child to a spouse family and a new sibling', async ({ page }) => {
    await openSeeded(page, seeded);
    let dialog = await addRelative(page, 'Add child');
    await dialog.getByRole('textbox', { name: 'Given names' }).fill('Lena');
    await dialog.getByRole('textbox', { name: 'Surname' }).fill('Ashdown');
    await dialog.getByRole('combobox', { name: 'Sex' }).click();
    await page.getByRole('option', { name: 'Female' }).click();
    await dialog.getByRole('textbox', { name: 'Birth date' }).fill('30 SEP 1906');
    await expect(dialog.getByRole('combobox', { name: 'Other parent' })).toHaveText(/Iris Vale/);
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog).toBeHidden();
    const spouse = relationships(page).getByRole('region', { name: 'Spouse and children' });
    await expect(spouse.getByRole('link', { name: /Lena Ashdown/ })).toBeVisible();
    await expect(timeline(page).getByText('Birth of daughter Lena Ashdown')).toBeVisible();

    dialog = await addRelative(page, 'Add sibling');
    await dialog.getByRole('textbox', { name: 'Given names' }).fill('Tobias');
    await dialog.getByRole('textbox', { name: 'Surname' }).fill('Ashdown');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(relationships(page).getByRole('link', { name: /Tobias Ashdown/ })).toBeVisible();
  });

  test('attaches an existing person as a spouse through search', async ({ page }) => {
    await openSeeded(page, seeded, seeded.iris);
    const dialog = await addRelative(page, 'Add spouse');
    await dialog.getByRole('radio', { name: 'Existing person' }).check();
    await dialog.getByRole('combobox', { name: 'Person' }).click();
    await page.keyboard.type('Wendell');
    await page.getByRole('option', { name: /Wendell Quarrier/ }).click();
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog).toBeHidden();
    await expect(relationships(page).getByRole('link', { name: /Wendell Quarrier/ })).toBeVisible();
  });

  test('adds a parent when one is missing and changes the child relationship type', async ({
    page,
  }) => {
    await openSeeded(page, seeded, seeded.iris);
    const dialog = await addRelative(page, 'Add parent');
    await dialog.getByRole('textbox', { name: 'Given names' }).fill('Ada');
    await dialog.getByRole('textbox', { name: 'Surname' }).fill('Vale');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(relationships(page).getByRole('region', { name: 'Parents' })).toContainText(
      'Ada Vale',
    );

    await page.goto(`/person/${seeded.rowan}`);
    const edit = await editPerson(page);
    await edit.getByRole('combobox', { name: 'Relationship to Edmund Ashdown' }).click();
    await page.getByRole('option', { name: 'Adopted' }).click();
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(timeline(page).getByText('Death of adoptive father Edmund Ashdown')).toBeVisible();
  });
});

test.describe('notes and tags', () => {
  test('adds, edits and deletes a note', async ({ page }) => {
    await openSeeded(page, seeded);
    await page.getByRole('tab', { name: 'Notes' }).click();
    const panel = page.getByRole('tabpanel');
    await panel.getByRole('button', { name: 'Add note' }).click();
    await panel.getByRole('textbox', { name: 'New note' }).fill('Kept the forge on Mill Lane.');
    await panel.getByRole('button', { name: 'Save note' }).click();
    await expect(panel.getByText('Kept the forge on Mill Lane.')).toBeVisible();

    await panel.getByRole('button', { name: 'Edit note' }).click();
    await panel
      .getByRole('textbox', { name: 'Note' })
      .fill('Kept the forge on Mill Lane until 1940.');
    await panel.getByRole('button', { name: 'Save note' }).click();
    await expect(panel.getByText('Kept the forge on Mill Lane until 1940.')).toBeVisible();

    await panel.getByRole('button', { name: 'Delete note' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete note' }).click();
    await expect(panel.getByRole('heading', { name: 'No notes yet' })).toBeVisible();
  });

  test('creates, attaches and detaches tags', async ({ page }) => {
    await openSeeded(page, seeded);
    const header = page.getByTestId('person-header');
    await header.getByRole('button', { name: 'Edit tags' }).click();
    const popover = page.getByRole('dialog', { name: 'Tags' });
    await popover.getByRole('textbox', { name: 'New tag' }).fill('Blacksmiths');
    await popover.getByRole('button', { name: 'Create tag' }).click();
    await expect(popover.getByRole('checkbox', { name: 'Blacksmiths' })).toBeChecked();
    await expect(header.getByText('Blacksmiths')).toBeVisible();
    await popover.getByRole('checkbox', { name: 'Blacksmiths' }).uncheck();
    await expect(header.getByText('Blacksmiths')).toHaveCount(0);
    await popover.getByRole('checkbox', { name: 'Blacksmiths' }).check();
    await expect(header.getByText('Blacksmiths')).toBeVisible();
  });
});

test.describe('history and errors', () => {
  test('history panel lists edits and undoes from the panel', async ({ page }) => {
    await openSeeded(page, seeded);
    const dialog = await editPerson(page);
    await dialog.getByRole('textbox', { name: 'Surname' }).first().fill('Ashdowne');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(h1(page)).toHaveText('Rowan Ashdowne');

    await page.getByRole('banner').getByRole('button', { name: 'History', exact: true }).click();
    const history = page.getByRole('dialog', { name: 'History' });
    await expect(history.getByRole('listitem').first()).toContainText('Edit person: Rowan Ashdown');
    await history.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('h1')).toHaveText('Rowan Ashdown');
    await expect(history.getByRole('listitem').first()).toContainText('undone');
    await history.getByRole('button', { name: 'Redo' }).click();
    await expect(page.locator('h1')).toHaveText('Rowan Ashdowne');
  });

  test('keeps nothing and says why when the session token is refused twice', async ({ page }) => {
    await openSeeded(page, seeded);
    let sessions = 0;
    await page.route('**/api/session', async (route) => {
      sessions++;
      await route.fallback();
    });
    await page.route(/\/api\/trees\/[^/]+\/batch$/, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'forbidden', message: 'Missing or invalid token' } }),
      }),
    );
    const dialog = await editPerson(page);
    await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Roan');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(toasts(page).filter({ hasText: 'Could not save' })).toContainText(
      'Missing or invalid token',
    );
    await expect(h1(page)).toHaveText('Rowan Ashdown');
    // The token is fetched for the first write, then once more before giving up.
    expect(sessions).toBe(2);
    await page.unroute(/\/api\/trees\/[^/]+\/batch$/);
    await page.reload();
    await expect(h1(page)).toHaveText('Rowan Ashdown');
  });

  test('refreshes the relationship line after a relationship edit', async ({ page }) => {
    // Wendell starts unrelated to the home person, Rowan.
    await openSeeded(page, seeded, seeded.wendell);
    await expect(h1(page)).toHaveText('Wendell Quarrier');
    await expect(page.getByTestId('relationship')).toHaveText('');
    await relationships(page).getByRole('button', { name: 'Add family member' }).click();
    await page.getByRole('menuitem', { name: 'Add child' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add child' });
    await dialog.getByRole('radio', { name: 'Existing person' }).check();
    await dialog.getByRole('combobox', { name: 'Person' }).click();
    await page.keyboard.type('Rowan');
    await page.getByRole('option', { name: /Rowan Ashdown/ }).click();
    await dialog.getByRole('button', { name: 'Add' }).click();
    // The cached ancestor slices are refetched, so the line updates in place.
    await expect(page.getByTestId('relationship')).toHaveText('father of Rowan Ashdown');
  });

  test('shows edits immediately and rolls back when the server fails', async ({ page }) => {
    await openSeeded(page, seeded);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/api\/trees\/[^/]+\/batch$/, async (route) => {
      await gate;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal_error', message: 'Disk full' } }),
      });
    });
    const dialog = await editPerson(page);
    await dialog.getByRole('textbox', { name: 'Given names' }).first().fill('Roan');
    await dialog.getByRole('button', { name: 'Save' }).click();
    // Optimistic: the new name shows before the server answers.
    await expect(h1(page)).toHaveText('Roan Ashdown');
    release();
    await expect(h1(page)).toHaveText('Rowan Ashdown');
    await expect(toasts(page).filter({ hasText: 'Could not save' })).toContainText('Disk full');
  });
});
