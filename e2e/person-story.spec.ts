import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { openTree } from '@open-ancestry/db';
import { importGedcom } from '../packages/import/src/index';
import { expect, test } from './fixtures';

/*
 * Timeline and LifeStory wording on the Ancestry sample (issues #128, #130,
 * #133): half and step relatives, adoption, date qualifiers in prose, custom
 * events, and family events that may fall after the person's death.
 */

const sample = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'ancestry-sample.ged'));

interface SampleTree {
  name: string;
  ids: Map<string, string>;
}

let sampleTree: Promise<SampleTree> | undefined;

/** Imports the sample into the e2e library once per worker, with people ids by name. */
function loadSample(): Promise<SampleTree> {
  sampleTree ??= (async () => {
    const info = test.info();
    const name = `Story sample ${info.project.name} ${info.workerIndex} ${Date.now() % 1e6}`;
    const dir = join(tmpdir(), `oa-e2e-library-${process.env.E2E_PORT}`, `${name}.oatree`);
    await importGedcom({ bytes: sample }, { dir, name });
    const store = openTree(dir);
    const rows = store.db
      .prepare(
        `SELECT p.id, n.given || ' ' || n.surname AS name FROM person p
         JOIN person_name n ON n.person_id = p.id AND n.is_primary = 1`,
      )
      .all() as { id: string; name: string }[];
    store.close();
    return { name, ids: new Map(rows.map((r) => [r.name, r.id])) };
  })();
  return sampleTree;
}

async function open(page: Page, person: string, search = '') {
  const { name, ids } = await loadSample();
  const id = ids.get(person);
  if (!id) throw new Error(`no ${person} in the sample`);
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), name);
  await page.goto(`/person/${id}${search}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(person);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

const timeline = (page: Page) =>
  page.getByRole('region', { name: 'Timeline', exact: true }).getByRole('listitem');

test.describe('timeline', () => {
  test('names a half-sister and a stepfather', async ({ page }) => {
    await open(page, 'George Eldermoor');
    const titles = timeline(page).locator('[data-title]');
    await expect(titles).toContainText(['Birth of half-sister Iris Hollowell']);
    await expect(titles).toContainText(['Death of stepfather Leopold Hollowell']);
    await expect(titles.filter({ hasText: /Birth of sister/ })).toHaveCount(0);
  });

  test('sorts a family event that may follow the death by its date, without an age', async ({
    page,
  }) => {
    await open(page, 'Thaddeus Ashgrove');
    const titles = await timeline(page).locator('[data-title]').allTextContents();
    const wife = titles.indexOf('Death of wife Mercy Bellweather (may be after his death)');
    // "bef. 1920" sorts after his 1911 death (#278), but gets no age.
    expect(titles.indexOf('Death')).toBeGreaterThan(-1);
    expect(wife).toBeGreaterThan(titles.indexOf('Death'));
    const row = timeline(page).filter({ hasText: 'Death of wife Mercy Bellweather' });
    await expect(row).not.toContainText('Age');
    // Undated facts stay at the end.
    expect(titles.at(-1)).toBe('Occupation: Cooper');
  });
});

test('relationships column marks half-siblings', async ({ page }) => {
  await open(page, 'George Eldermoor');
  const family = page.getByRole('region', { name: 'Relationships', exact: true });
  await expect(family.getByRole('button', { name: /^Half-siblings/ })).toHaveText(
    'Half-siblings (1)',
  );
  await expect(family.getByRole('region', { name: /^Half-siblings/ })).toContainText(
    'Iris Hollowell',
  );
  await expect(family.getByRole('button', { name: /^Siblings/ })).toHaveCount(0);
});

test.describe('LifeStory', () => {
  const story = async (page: Page, name: string) => {
    await open(page, name, '?tab=lifestory');
    return page.getByRole('tabpanel');
  };

  test('spells out date qualifiers', async ({ page }) => {
    let panel = await story(page, 'Thaddeus Ashgrove');
    await expect(panel).toContainText(
      'Thaddeus Ashgrove was born about 1842 in Hollin Cross, Westmarch, England.',
    );
    panel = await story(page, 'Clementine Ashgrove');
    await expect(panel).toContainText('Clementine Ashgrove was born between 1870 and 1872');
    await expect(panel).toContainText('Her mother, Mercy Bellweather, died before 1920.');
    await expect(panel).toContainText('She died after 1950');
    panel = await story(page, 'Lily Mosswood');
    await expect(panel).toContainText(/Between 2010 and 2019 she lived in /);
    await expect(panel).not.toContainText(/\b(abt|bet|bef|aft)\./);
  });

  test('tells custom events', async ({ page }) => {
    const panel = await story(page, 'Thaddeus Ashgrove');
    await expect(panel).toContainText(
      'He arrived in Millbrook, Harlow County, Vermont, USA in 1866.',
    );
  });

  test('keeps step-children apart from the couple’s children', async ({ page }) => {
    const panel = await story(page, 'Edith Ashgrove');
    await expect(panel).toContainText(
      'She married Leopold Hollowell in 1928. Together they had one child: Iris.',
    );
    await expect(panel).toContainText('Leopold was stepfather to George.');
  });

  test('words half-siblings and step-parents', async ({ page }) => {
    const panel = await story(page, 'George Eldermoor');
    await expect(panel).toContainText('He had one half-sister.');
    await expect(panel).toContainText('His stepfather was Leopold Hollowell.');
  });

  test('tells an adoption', async ({ page }) => {
    const panel = await story(page, 'Peter Ashgrove');
    await expect(panel).toContainText(
      'He was adopted in 1964 by Harold Ashgrove and Dorothy Ingleby.',
    );
    await expect(panel).not.toContainText('the son of Harold Ashgrove');
  });
});
