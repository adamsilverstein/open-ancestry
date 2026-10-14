import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openSamplePerson, setHome } from './sample-tree';

/*
 * Relationship to the home person, the any-to-any calculator and the home
 * person action on the Ancestry sample (issues #125, #128, #129, #132).
 */

const relationship = (page: Page) => page.getByTestId('relationship');

async function relationshipOf(page: Page, person: string, home: string) {
  await setHome(page, home);
  await openSamplePerson(page, person);
  return relationship(page);
}

test.describe('relationship to the home person', () => {
  for (const [person, home, text] of [
    // In-laws (#129).
    ['Dorothy Ingleby', 'Ruth Ashgrove', 'sister-in-law of Ruth Ashgrove'],
    ['Ryan Mosswood', 'Thomas Ashgrove', 'son-in-law of Thomas Ashgrove'],
    ['Harriet Corran', 'Mabel Corran', 'aunt and also mother-in-law of Mabel Corran'],
    ['Walter Ashgrove', 'Mabel Corran', 'husband and also double 1st cousin of Mabel Corran'],
    ['Mabel Corran', 'Josiah Ashgrove', 'niece and also daughter-in-law of Josiah Ashgrove'],
    // Half and step (#128).
    ['Iris Hollowell', 'George Eldermoor', 'half-sister of George Eldermoor'],
    ['Leopold Hollowell', 'George Eldermoor', 'stepfather of George Eldermoor'],
    // Arthur died before Iris was born: never her stepfather.
    ['Arthur Eldermoor', 'Iris Hollowell', 'husband of mother of Iris Hollowell'],
  ] as const) {
    test(`${person} with home ${home}`, async ({ page }) => {
      await expect(await relationshipOf(page, person, home)).toHaveText(text);
    });
  }

  test('names a step link on the path chart', async ({ page }) => {
    await relationshipOf(page, 'Leopold Hollowell', 'George Eldermoor');
    await page.getByRole('button', { name: 'Show path' }).click();
    const chart = page.getByRole('dialog', { name: 'Relationship path' });
    await expect(chart.getByRole('listitem').nth(1)).toContainText('stepson of Leopold Hollowell');
  });
});

test.describe('relationship paths', () => {
  test('labels collapsed paths by the line they take', async ({ page }) => {
    await relationshipOf(page, 'Lily Mosswood', 'Thaddeus Ashgrove');
    await page.getByRole('button', { name: 'Show path' }).click();
    const chart = page.getByRole('dialog', { name: 'Relationship path' });
    await chart.getByRole('combobox', { name: /Path/ }).click();
    const options = page.getByRole('option');
    await expect(options).toHaveText([
      /^4th great-granddaughter through (Josiah|Clementine) Ashgrove$/,
      /^4th great-granddaughter through (Josiah|Clementine) Ashgrove$/,
    ]);
    await expect(options.filter({ hasText: 'Josiah' })).toHaveCount(1);
    await expect(options.filter({ hasText: '(line' })).toHaveCount(0);
  });

  test('keeps the path popover inside a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await relationshipOf(page, 'Lily Mosswood', 'Thaddeus Ashgrove');
    await page.getByRole('button', { name: 'Show path' }).click();
    const box = await page.getByRole('dialog', { name: 'Relationship path' }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});

test.describe('home person and calculator (#125)', () => {
  test('sets the home person from the person page, undoably', async ({ page }) => {
    await setHome(page, 'Thaddeus Ashgrove');
    await openSamplePerson(page, 'Margaret Ashgrove');
    await expect(relationship(page)).not.toHaveText('Home person');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Set as home person' }).click();
    await expect(relationship(page)).toHaveText('Home person');
    await expect(page.getByText('Margaret Ashgrove is now the home person').first()).toBeVisible();
    // Undo puts Thaddeus back.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(relationship(page)).toContainText('of Thaddeus Ashgrove');
  });

  async function calculate(page: Page, person: string, other: string) {
    await openSamplePerson(page, person);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Relationship to…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Relationship calculator' });
    // Prefilled with the home person; wait for that answer before changing it.
    await expect(dialog.getByTestId('calculator-name')).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Related to' }).click();
    await page.keyboard.type(other);
    await page.getByRole('option', { name: new RegExp(`^${other}`) }).click();
    return dialog;
  }

  for (const [person, other, name] of [
    [
      'George Eldermoor',
      'Margaret Ashgrove',
      '1st cousin 1x removed and also double 2nd cousin 1x removed',
    ],
    ['Susan Larkspur', 'Margaret Ashgrove', 'sister-in-law'],
    ['Peter Ashgrove', 'Harold Ashgrove', 'adopted son'],
  ] as const) {
    test(`calculates ${person} to ${other}`, async ({ page }) => {
      await setHome(page, 'Thaddeus Ashgrove');
      const dialog = await calculate(page, person, other);
      await expect(dialog.getByTestId('calculator-name')).toHaveText(
        `${person} is the ${name} of ${other}.`,
      );
      const chart = dialog.getByRole('list', { name: /^Relationship path/ });
      await expect(chart.getByRole('link', { name: new RegExp(`^${person}`) })).toBeVisible();
      await expect(chart.getByRole('link', { name: new RegExp(`^${other}`) })).toBeVisible();
    });
  }

  test('lists every path for pedigree collapse', async ({ page }) => {
    await setHome(page, 'Ruth Ashgrove');
    const dialog = await calculate(page, 'Harold Ashgrove', 'Thaddeus Ashgrove');
    await expect(dialog.getByTestId('calculator-name')).toHaveText(
      'Harold Ashgrove is the great-grandson of Thaddeus Ashgrove.',
    );
    await dialog.getByRole('combobox', { name: 'Path (2)' }).click();
    await expect(page.getByRole('option')).toHaveCount(2);
  });
});
