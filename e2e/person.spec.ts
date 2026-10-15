import type { Page } from '@playwright/test';
import { FIXTURE_PEOPLE, readManifest } from './tree-fixture';
import { expect, test } from './fixtures';

const people = FIXTURE_PEOPLE;

function column(page: Page, name: string) {
  return page.getByRole('region', { name, exact: true });
}

async function openPerson(page: Page, id: string, search = '') {
  await page.goto(`/person/${id}${search}`);
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test.describe('header', () => {
  test('shows name, vitals, relationship, tags and photo fallback', async ({ page }) => {
    await openPerson(page, people.rowan);
    const header = page.getByTestId('person-header');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rowan Ashdown');
    await expect(header.getByText('Birth', { exact: true })).toBeVisible();
    await expect(header).toContainText('12 Mar 1880');
    await expect(header).toContainText('Brackenford, Westmere');
    await expect(header.getByText('Death', { exact: true })).toBeVisible();
    await expect(header).toContainText('3 Nov 1950');
    await expect(header.getByTestId('relationship')).toHaveText('Home person');
    await expect(header.getByText('Blacksmiths')).toBeVisible();
    await expect(header.getByRole('img', { name: 'Rowan Ashdown, male' })).toBeVisible();
    // The display name uses the serif face.
    const font = await page
      .getByRole('heading', { level: 1 })
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(font).toContain('Source Serif 4 Variable');
  });

  for (const [key, relationship] of [
    ['edmund', 'father of Rowan Ashdown'],
    ['silas', 'grandfather of Rowan Ashdown'],
    ['pip', 'grandson of Rowan Ashdown'],
    ['felix', '1st cousin of Rowan Ashdown'],
    ['wendell', 'nephew of Rowan Ashdown'],
    ['iris', 'wife of Rowan Ashdown'],
  ] as const) {
    test(`relationship to the home person: ${key}`, async ({ page }) => {
      await openPerson(page, people[key]);
      await expect(page.getByTestId('relationship')).toHaveText(relationship);
    });
  }

  test('shows how a relative connects to the home person', async ({ page }) => {
    await openPerson(page, people.felix);
    await page.getByRole('button', { name: 'Show path' }).click();
    const chart = page.getByRole('dialog', { name: 'Relationship path' });
    await expect(chart.getByRole('listitem')).toHaveText([
      /^Felix Ashdown/,
      /^Horace Ashdown/,
      /^Silas Ashdown/,
      /^Edmund Ashdown/,
      /^Rowan Ashdown/,
    ]);
    await expect(chart.getByText('Common ancestor')).toBeVisible();
    // Screen readers hear each card's name and lifespan, and how it relates to the one before.
    await expect(chart.getByRole('link', { name: 'Horace Ashdown, 1848 to 1910' })).toBeVisible();
    await expect(chart.getByText('father of Felix Ashdown')).toBeAttached();
    await expect(chart.getByText('son of Silas Ashdown')).toBeAttached();
    await expect(chart.getByText('This person')).toBeAttached();
    await chart.getByRole('link', { name: /Silas Ashdown/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Silas Ashdown');
  });

  test('offers no path for the home person', async ({ page }) => {
    await openPerson(page, people.rowan);
    await expect(page.getByTestId('relationship')).toHaveText('Home person');
    await expect(page.getByRole('button', { name: 'Show path' })).toHaveCount(0);
  });

  test('shows Living for a living person', async ({ page }) => {
    await openPerson(page, people.lena);
    const header = page.getByTestId('person-header');
    await expect(header.getByText('Death', { exact: true })).toBeVisible();
    await expect(header.getByText('Living', { exact: true })).toBeVisible();
  });

  test('links to the person in the tree', async ({ page }) => {
    await openPerson(page, people.rowan);
    await expect(page.getByRole('link', { name: 'View in tree' })).toHaveAttribute(
      'href',
      `/tree/${people.rowan}`,
    );
  });
});

test.describe('tabs', () => {
  test('lists the five tabs and keeps the selection in the URL', async ({ page }) => {
    await openPerson(page, people.rowan);
    const tabs = page.getByRole('tablist', { name: 'Person sections' }).getByRole('tab');
    await expect(tabs).toHaveText(['Facts', 'Gallery', 'Notes', 'LifeStory', 'Sources']);
    await expect(page.getByRole('tab', { name: 'Facts' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Notes' }).click();
    await expect(page).toHaveURL(/[?&]tab=notes(&|$)/);
    await expect(page.getByRole('tabpanel')).toContainText('Rowan kept the forge on Mill Lane');
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
  });

  test('gallery shows an empty state without media', async ({ page }) => {
    await openPerson(page, people.rowan, '?tab=gallery');
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByRole('heading', { name: 'No media yet' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Add media' })).toBeVisible();
  });

  test('sources tab groups citations by source', async ({ page }) => {
    await openPerson(page, people.rowan, '?tab=sources');
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByText('1911 Northvale Census')).toBeVisible();
    await expect(panel.getByText('Brackenford Parish Register')).toBeVisible();
    await expect(panel.getByText('Ashdown Family Bible')).toBeVisible();
  });

  test('LifeStory tells the life in generated paragraphs', async ({ page }) => {
    await openPerson(page, people.rowan, '?tab=lifestory');
    const panel = page.getByRole('tabpanel');
    await expect(panel).toContainText(
      'Rowan Ashdown was born on 12 Mar 1880 in Brackenford, Westmere, the son of Edmund Ashdown and Clara Penhallow.',
    );
    await expect(panel).toContainText('He married Iris Vale on 14 Jun 1905 in Ashcombe, Eastholm.');
    await expect(panel).toContainText(
      'He died on 3 Nov 1950 in Thornbury, Northvale, at the age of 70, and was buried in Thornbury, Northvale.',
    );
  });
});

test.describe('facts', () => {
  test('timeline interleaves family events in date order with ages', async ({ page }) => {
    await openPerson(page, people.rowan);
    const items = column(page, 'Timeline').getByRole('listitem');
    await expect(items.locator('[data-title]')).toHaveText([
      'Birth',
      'Birth',
      'Birth of brother Tobias Ashdown',
      'Residence',
      'Death of father Edmund Ashdown',
      'Birth of half sister Nell Marsh',
      'Marriage to Iris Vale',
      'Birth of daughter Lena Ashdown',
      'Birth of son Arthur Ashdown',
      'Occupation: Blacksmith',
      'Census',
      'Death of mother Clara Penhallow',
      'Death of wife Iris Vale',
      'Death of son Arthur Ashdown',
      'Death',
      'Burial',
    ]);
    // Alternate birth is grouped right under the preferred one.
    await expect(items.nth(1)).toContainText('alternate');
    await expect(items.nth(1)).toContainText('abt. 1879');
    await expect(items.filter({ hasText: 'Marriage to Iris Vale' })).toContainText('Age 25');
    // Year-only dates give an approximate age.
    await expect(items.filter({ hasText: 'Census' })).toContainText('Age about 31');
    await expect(items.filter({ hasText: 'Birth of brother' })).toContainText('Family event');
  });

  test('timeline filters by event category', async ({ page }) => {
    await openPerson(page, people.rowan);
    const timeline = column(page, 'Timeline');
    await timeline.getByRole('button', { name: 'Filter events' }).click();
    const filter = page.getByRole('dialog', { name: 'Filter events' });
    await filter.getByRole('checkbox', { name: 'Family events' }).uncheck();
    await expect(timeline.getByText(/Birth of brother/)).toHaveCount(0);
    await expect(timeline.getByText('Marriage to Iris Vale')).toBeVisible();
    await filter.getByRole('checkbox', { name: 'Residence and work' }).uncheck();
    await expect(timeline.getByText('Census')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(timeline.getByRole('button', { name: 'Filter events' })).toContainText('2 hidden');
  });

  test('sources column links Ancestry records', async ({ page }) => {
    await openPerson(page, people.rowan);
    const sources = column(page, 'Sources');
    await expect(sources.getByText('1911 Northvale Census')).toBeVisible();
    await expect(sources.getByText('Thornbury, folio 12, schedule 88')).toBeVisible();
    await expect(sources.getByRole('link', { name: /View record on Ancestry/ })).toHaveAttribute(
      'href',
      'https://www.ancestry.com/discoveryui-content/view/30542144:7572',
    );
    await expect(sources.getByText('Ashdown Family Bible')).toBeVisible();
  });

  test('relationships list parents, collapsible siblings, spouses with children', async ({
    page,
  }) => {
    await openPerson(page, people.rowan);
    const family = column(page, 'Relationships');
    const parents = family.getByRole('region', { name: 'Parents' });
    await expect(parents.getByRole('link')).toHaveText([/Edmund Ashdown/, /Clara Penhallow/]);

    const toggle = family.getByRole('button', { name: /Siblings/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(family.getByRole('link', { name: /Tobias Ashdown/ })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(family.getByRole('link', { name: /Tobias Ashdown/ })).toBeHidden();

    const half = family.getByRole('button', { name: /Half siblings/ });
    await expect(half).toHaveText('Half siblings (1)');
    await expect(family.getByRole('link', { name: /Nell Marsh/ })).toBeVisible();

    const spouse = family.getByRole('region', { name: 'Spouse and children' });
    await expect(spouse.getByRole('link')).toHaveText([
      /Iris Vale/,
      /Lena Ashdown/,
      /Arthur Ashdown/,
    ]);

    await parents.getByRole('link', { name: /Edmund Ashdown/ }).click();
    await expect(page).toHaveURL(new RegExp(`/person/${people.edmund}(\\?tree=[^&]*)?$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Edmund Ashdown');
  });

  test('all five tabs fit at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openPerson(page, people.rowan);
    const list = page.getByRole('tablist', { name: 'Person sections' });
    // The tab bar around the list is the horizontal scroller.
    const overflow = await list.evaluate(
      (el) => el.parentElement!.scrollWidth - el.parentElement!.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('three columns on wide screens, one column on narrow', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openPerson(page, people.rowan);
    const boxes = async () =>
      Promise.all(
        ['Timeline', 'Sources', 'Relationships'].map(
          async (name) => (await column(page, name).boundingBox())!,
        ),
      );
    let [timeline, sources, family] = await boxes();
    expect(timeline!.x).toBeLessThan(sources!.x);
    expect(sources!.x).toBeLessThan(family!.x);
    expect(timeline!.width).toBeGreaterThan(sources!.width);

    await page.setViewportSize({ width: 600, height: 900 });
    [timeline, sources, family] = await boxes();
    expect(sources!.x).toBe(timeline!.x);
    expect(family!.x).toBe(timeline!.x);
    expect(sources!.y).toBeGreaterThan(timeline!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      600,
    );
  });
});

test('unknown person shows a not found state', async ({ page }) => {
  await page.goto('/person/01NOSUCHPERSON0000000000000');
  await expect(page.getByRole('heading', { level: 1, name: 'Person not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go home' })).toBeVisible();
});

test('an id that cannot exist shows the not found state, not an error (#143)', async ({ page }) => {
  await page.goto("/person/x'y");
  await expect(page.getByRole('heading', { level: 1, name: 'Person not found' })).toBeVisible();
  await expect(page.getByText(/Something went wrong|must match pattern/)).toHaveCount(0);
});

test('shows a sized skeleton while loading', async ({ page }) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/trees\/[^/]+\/people\//, async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto(`/person/${people.rowan}`);
  const region = page.getByRole('region', { name: 'Person' });
  await expect(region).toHaveAttribute('aria-busy', 'true');
  await expect(region.getByTestId('skeleton').first()).toBeVisible();
  release();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rowan Ashdown');
});

test.describe('performance', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Timing budget measured in Chromium');

  test('person page renders in under 100ms from click on a 10k tree (median of 5)', async ({
    page,
  }) => {
    const { synthetic } = readManifest();
    await openPerson(page, synthetic);
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      // The last row (a child or spouse) is not prefetched; parents are, for half siblings.
      const link = page.getByRole('region', { name: 'Relationships' }).getByRole('link').last();
      const target = (await link.getAttribute('href'))!;
      const name = (await link.getAttribute('data-name'))!;
      const ms = await link.evaluate(
        (el, expected) =>
          new Promise<number>((resolve) => {
            const start = performance.now();
            const check = () => {
              const h1 = document.querySelector('h1');
              if (h1?.textContent === expected && !document.querySelector('[aria-busy="true"]')) {
                resolve(performance.now() - start);
              } else requestAnimationFrame(check);
            };
            (el as HTMLElement).click();
            requestAnimationFrame(check);
          }),
        name,
      );
      await expect(page).toHaveURL(new RegExp(`${target}(\\?tree=[^&]*)?$`));
      timings.push(ms);
    }
    timings.sort((a, b) => a - b);
    const median = timings[2]!;
    console.log(
      `person page from click: median ${median.toFixed(1)}ms, all ${timings.map((t) => t.toFixed(0)).join(', ')}`,
    );
    expect(median).toBeLessThan(100);
  });
});
