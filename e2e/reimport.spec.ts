import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Locator, Page, TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

/*
 * Re-import (issue #56): import, edit, re-import a modified export, review,
 * apply, then undo. Each test gets its own tree, since undo is per tree.
 */

const SAMPLE = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'ancestry-sample.ged'),
  'utf8',
);
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** A later Ancestry export: renumbered xrefs, a refined birth, a changed death, a new child, one person gone. */
function laterExport(): string {
  return SAMPLE.replace('2 DATE Abt. 1842', '2 DATE 12 MAR 1842')
    .replace('2 DATE 1939', '2 DATE 1940')
    .replace(
      '0 @F1@ FAM',
      [
        '0 @I27@ INDI',
        '1 NAME Noah /Ashgrove/',
        '1 SEX M',
        '1 BIRT',
        '2 DATE 1992',
        '1 FAMC @F9@',
        '0 @F1@ FAM',
      ].join('\n'),
    )
    .replace('1 CHIL @I24@', '1 CHIL @I24@\n1 CHIL @I27@')
    .replace(/0 @I26@ INDI\n(?:[1-9].*\n)+/, '')
    .replace('1 CHIL @I26@\n', '')
    .replace(/@([A-Z]+)(\d+)@/g, (_, p: string, n: string) => `@${p}${Number(n) + 100}@`);
}

interface Seeded {
  tree: string;
  headers: Record<string, string>;
}

async function seed(
  request: APIRequestContext,
  baseURL: string,
  testInfo: TestInfo,
): Promise<Seeded> {
  const { token } = (await (await request.get('/api/session')).json()) as { token: string };
  const headers = { origin: new URL(baseURL).origin, 'x-oa-token': token };
  const name = `Reimport ${testInfo.project.name} ${testInfo.workerIndex}${testInfo.retry} ${Date.now() % 1e6}`;
  // The e2e server runs one import at a time with a short queue, shared with
  // other specs' large imports: retry a full queue (429) and allow for waiting.
  let jobId: string | undefined;
  await expect
    .poll(
      async () => {
        const started = await request.post('/api/import', {
          headers,
          multipart: {
            file: {
              name: `${name}.ged`,
              mimeType: 'application/octet-stream',
              buffer: Buffer.from(SAMPLE),
            },
          },
        });
        if (started.status() === 202) jobId = ((await started.json()) as { jobId: string }).jobId;
        return started.status();
      },
      { timeout: 60_000, intervals: [500, 1000, 2000] },
    )
    .toBe(202);
  await expect
    .poll(async () => (await (await request.get(`/api/jobs/${jobId}`)).json()).state, {
      timeout: 60_000,
    })
    .toBe('completed');
  const job = (await (await request.get(`/api/jobs/${jobId}`)).json()) as { tree: string };
  return { tree: job.tree, headers };
}

async function personByName(request: APIRequestContext, tree: string, given: string) {
  const res = await request.get(`/api/trees/${encodeURIComponent(tree)}/search?q=${given}&limit=5`);
  const { items } = (await res.json()) as { items: { person: { id: string; given: string } }[] };
  return items.find((i) => i.person.given === given)?.person.id;
}

async function eventDate(request: APIRequestContext, tree: string, personId: string, type: string) {
  const detail = (await (
    await request.get(`/api/trees/${encodeURIComponent(tree)}/people/${personId}`)
  ).json()) as { events: { event: { id: string; type: string; date_text: string } }[] };
  return detail.events.find((e) => e.event.type === type)!.event;
}

async function startReimport(page: Page, seeded: Seeded, text = laterExport()) {
  await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), seeded.tree);
  await page.goto('/');
  await page.getByRole('button', { name: 'File' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Re-import updated export/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'Ashgrove 2026.ged',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(text),
  });
  await expect(
    page.getByRole('heading', { level: 1, name: 'Review the updated export' }),
  ).toBeVisible({
    timeout: 30_000,
  });
}

const card = (scope: Page | Locator, name: string) =>
  // Person cards are articles; regions are kept for the four groups.
  scope.getByRole('article', { name, exact: true });

test('import, edit, re-import, review, apply, then undo', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  const thaddeus = (await personByName(request, seeded.tree, 'Thaddeus'))!;
  const josiah = (await personByName(request, seeded.tree, 'Josiah'))!;
  // A local edit the export does not know about.
  const death = await eventDate(request, seeded.tree, josiah, 'DEAT');
  const edited = await request.patch(
    `/api/trees/${encodeURIComponent(seeded.tree)}/events/${death.id}`,
    {
      headers: seeded.headers,
      data: { date_text: '3 MAY 1939' },
    },
  );
  expect(edited.ok()).toBe(true);

  await startReimport(page, seeded);
  const summary = page.getByRole('region', { name: 'Summary' });
  await expect(summary).toContainText('25 matched');
  await expect(summary).toContainText('1 new');
  await expect(summary).toContainText('1 missing');

  const birth = card(page, 'Thaddeus Ashgrove').getByRole('checkbox', {
    name: /Birth: abt\. 1842 → 12 Mar 1842/,
  });
  await expect(birth).toBeChecked();
  await expect(card(page, 'Thaddeus Ashgrove')).toContainText(/\d+% match/);
  const deathChange = card(page, 'Josiah Ashgrove').getByRole('checkbox', {
    name: /Death: 3 May 1939 → 1940/,
  });
  await expect(deathChange).not.toBeChecked();
  await expect(card(page, 'Josiah Ashgrove')).toContainText('Edited in this tree');
  await expect(
    card(page, 'Noah Ashgrove').getByRole('checkbox', { name: /Add Noah Ashgrove/ }),
  ).toBeChecked();
  await expect(card(page, 'Lily Mosswood')).toContainText('Not in the new export');
  await expect(card(page, 'Lily Mosswood').getByRole('checkbox')).toHaveCount(0);

  await page.getByRole('button', { name: /^Apply \d+ changes?$/ }).click();
  await expect(
    page
      .getByRole('region', { name: /Notifications/ })
      .getByRole('listitem')
      .filter({ hasText: /Applied \d+ change/ }),
  ).toBeVisible({ timeout: 30_000 });
  // The result lists what was applied, by person, with links, and what was skipped (#158).
  const result = page.getByRole('region', { name: 'Re-import applied' });
  await expect(result).toBeVisible();
  const thaddeusLink = result.getByRole('link', { name: 'Thaddeus Ashgrove' });
  await expect(thaddeusLink).toHaveAttribute('href', new RegExp(`/person/${thaddeus}$`));
  await expect(result.getByRole('link', { name: 'Noah Ashgrove' })).toBeVisible();
  await expect(
    result.getByText(/Birth: abt\. 1842 → 12 Mar 1842|Birth: Abt\. 1842 → 12 MAR 1842/),
  ).toBeVisible();
  await expect(result.getByText(/^Skipped \d+ change/)).toBeVisible();
  expect((await eventDate(request, seeded.tree, thaddeus, 'BIRT')).date_text).toBe('12 MAR 1842');
  expect((await eventDate(request, seeded.tree, josiah, 'DEAT')).date_text).toBe('3 MAY 1939');
  expect(await personByName(request, seeded.tree, 'Noah')).toBeTruthy();
  expect(await personByName(request, seeded.tree, 'Lily')).toBeTruthy();

  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press(`${mod}+z`);
  await expect(
    page
      .getByRole('region', { name: /Notifications/ })
      .getByRole('listitem')
      .filter({ hasText: 'Undid Re-import' }),
  ).toBeVisible();
  // Undo dismisses the Applied toast, so the two don't sit side by side.
  await expect(
    page
      .getByRole('region', { name: /Notifications/ })
      .getByRole('listitem')
      .filter({ hasText: /Applied \d+ change/ }),
  ).toHaveCount(0);
  // The result page says so too, and stops linking to people the undo removed.
  const undone = page.getByRole('region', { name: 'Re-import undone' });
  await expect(undone).toContainText('This re-import was undone');
  // Noah was added by the re-import, so undo removed him and his link goes;
  // Thaddeus was only updated, still exists, and keeps his link.
  await expect(undone.getByRole('link', { name: 'Noah Ashgrove' })).toHaveCount(0);
  await expect(undone.getByRole('link', { name: 'Thaddeus Ashgrove' })).toHaveAttribute(
    'href',
    new RegExp(`/person/${thaddeus}$`),
  );
  await expect(undone.getByText('Noah Ashgrove', { exact: true }).first()).toBeVisible();
  // Redo applies it again, and the page follows.
  await page.keyboard.press(`Shift+${mod}+z`);
  await expect(result.getByRole('link', { name: 'Noah Ashgrove' })).toBeVisible();
  await page.keyboard.press(`${mod}+z`);
  await expect(undone).toBeVisible();
  await undone.getByRole('link', { name: 'Go to the tree' }).click();
  await expect(page).toHaveURL(/\/(tree|person)\//);
  expect((await eventDate(request, seeded.tree, thaddeus, 'BIRT')).date_text).toBe('Abt. 1842');
  expect(await personByName(request, seeded.tree, 'Noah')).toBeUndefined();
});

test('rejecting changes, overriding a local edit and bulk selection', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  const thaddeus = (await personByName(request, seeded.tree, 'Thaddeus'))!;
  const josiah = (await personByName(request, seeded.tree, 'Josiah'))!;
  const death = await eventDate(request, seeded.tree, josiah, 'DEAT');
  await request.patch(`/api/trees/${encodeURIComponent(seeded.tree)}/events/${death.id}`, {
    headers: seeded.headers,
    data: { date_text: '3 MAY 1939' },
  });
  await startReimport(page, seeded);

  const apply = page.getByRole('button', { name: /^Apply \d+ changes?$/ });
  await page.getByRole('button', { name: 'Accept none' }).click();
  await expect(page.getByRole('button', { name: 'Apply 0 changes' })).toBeDisabled();
  await page.getByRole('button', { name: 'Accept all high-confidence' }).click();
  // Bulk accept leaves local edits alone.
  await expect(
    card(page, 'Josiah Ashgrove').getByRole('checkbox', { name: /Death: 3 May 1939 → 1940/ }),
  ).not.toBeChecked();
  // The new child depends on Noah being added.
  await card(page, 'Noah Ashgrove')
    .getByRole('checkbox', { name: /Add Noah Ashgrove/ })
    .uncheck();
  await expect(
    card(page, 'Noah Ashgrove').getByRole('checkbox', { name: /Child of/ }),
  ).toBeDisabled();
  await card(page, 'Thaddeus Ashgrove')
    .getByRole('checkbox', { name: /Birth:/ })
    .uncheck();
  await card(page, 'Josiah Ashgrove')
    .getByRole('checkbox', { name: /Death: 3 May 1939 → 1940/ })
    .check();
  await apply.click();
  await expect(
    page
      .getByRole('region', { name: /Notifications/ })
      .getByRole('listitem')
      .filter({ hasText: /Applied \d+ change/ }),
  ).toBeVisible({ timeout: 30_000 });
  expect((await eventDate(request, seeded.tree, thaddeus, 'BIRT')).date_text).toBe('Abt. 1842');
  expect((await eventDate(request, seeded.tree, josiah, 'DEAT')).date_text).toBe('1940');
  expect(await personByName(request, seeded.tree, 'Noah')).toBeUndefined();
});

test('a fact deleted here is offered back unticked, and stays deleted by default', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  const mercy = (await personByName(request, seeded.tree, 'Mercy'))!;
  const death = await eventDate(request, seeded.tree, mercy, 'DEAT');
  const removed = await request.delete(
    `/api/trees/${encodeURIComponent(seeded.tree)}/events/${death.id}`,
    { headers: seeded.headers },
  );
  expect(removed.ok()).toBe(true);
  // Ancestry changed the fact the user deleted: now both differ, so it asks (#185).
  // (An export that still has it as it was offers nothing.)
  await startReimport(page, seeded, laterExport().replace('2 DATE BEF 1920', '2 DATE ABT 1918'));
  const restore = card(page, 'Mercy Bellweather').getByRole('checkbox', {
    name: /Add fact: Death/,
  });
  await expect(restore).not.toBeChecked();
  await expect(
    card(page, 'Mercy Bellweather').getByText(
      'You deleted this in this tree; it stays deleted unless you tick this.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Accept all high-confidence' }).click();
  await expect(restore).not.toBeChecked();
});

test('a partner dropped from the export adds no parent family by default', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  const parentFamilies = async (given: string) => {
    const id = (await personByName(request, seeded.tree, given))!;
    const detail = (await (
      await request.get(`/api/trees/${encodeURIComponent(seeded.tree)}/people/${id}`)
    ).json()) as { parentFamilies: unknown[] };
    return detail.parentFamilies.length;
  };
  const before = { george: await parentFamilies('George'), iris: await parentFamilies('Iris') };
  // Ancestry no longer lists Leopold as Edith's husband.
  const leopold = /0 @I16@ INDI\n(?:[1-9].*\n)+/.exec(SAMPLE)![0];
  const text = SAMPLE.replace(leopold, leopold.replace('1 FAMS @F7@\n', ''))
    .replace('0 @F7@ FAM\n1 HUSB @I16@\n', '0 @F7@ FAM\n')
    // And one ordinary change, so there is something to apply.
    .replace('2 DATE Abt. 1842', '2 DATE 12 MAR 1842')
    .replace(/@([A-Z]+)(\d+)@/g, (_, p: string, n: string) => `@${p}${Number(n) + 100}@`);
  await startReimport(page, seeded, text);
  await expect(page.getByRole('checkbox', { name: /Child of/ })).toHaveCount(0);
  await expect(page.getByText(/Not in the new export: partner Leopold Hollowell/)).toHaveCount(1);
  await page.getByRole('button', { name: 'Apply 1 change' }).click();
  await expect(
    page
      .getByRole('region', { name: /Notifications/ })
      .getByRole('listitem')
      .filter({ hasText: /Applied 1 change/ }),
  ).toBeVisible({ timeout: 30_000 });
  expect(await parentFamilies('George')).toBe(before.george);
  expect(await parentFamilies('Iris')).toBe(before.iris);
});

test('a review the tree moved past offers Compare again, keeping the choices made', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  const thaddeus = (await personByName(request, seeded.tree, 'Thaddeus'))!;
  const josiah = (await personByName(request, seeded.tree, 'Josiah'))!;
  await startReimport(page, seeded);
  const birth = card(page, 'Thaddeus Ashgrove').getByRole('checkbox', { name: /Birth:/ });
  await birth.uncheck();
  // Someone edits the tree (another tab) while the review is open.
  const death = await eventDate(request, seeded.tree, josiah, 'DEAT');
  await request.patch(`/api/trees/${encodeURIComponent(seeded.tree)}/events/${death.id}`, {
    headers: seeded.headers,
    data: { date_text: '3 MAY 1939' },
  });
  // Coming back to the page notices it.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const banner = page.getByRole('alert').filter({ hasText: 'Your tree changed' });
  await expect(banner).toBeVisible();
  await expect(page.getByRole('button', { name: /^Apply \d+ changes?$/ })).toBeDisabled();
  await banner.getByRole('button', { name: 'Compare again' }).click();
  await expect(banner).toBeHidden();
  // The choice made before is kept; the edited death is now a local edit, unticked.
  await expect(birth).not.toBeChecked();
  await expect(
    card(page, 'Josiah Ashgrove').getByRole('checkbox', { name: /Death: 3 May 1939 → 1940/ }),
  ).not.toBeChecked();
  await page.getByRole('button', { name: /^Apply \d+ changes?$/ }).click();
  await expect(
    page
      .getByRole('region', { name: /Notifications/ })
      .getByRole('listitem')
      .filter({ hasText: /Applied \d+ change/ }),
  ).toBeVisible({ timeout: 30_000 });
  expect((await eventDate(request, seeded.tree, thaddeus, 'BIRT')).date_text).toBe('Abt. 1842');
  expect((await eventDate(request, seeded.tree, josiah, 'DEAT')).date_text).toBe('3 MAY 1939');
});

test('applying a review the tree moved past shows Compare again instead', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  const josiah = (await personByName(request, seeded.tree, 'Josiah'))!;
  await startReimport(page, seeded);
  const death = await eventDate(request, seeded.tree, josiah, 'DEAT');
  await request.patch(`/api/trees/${encodeURIComponent(seeded.tree)}/events/${death.id}`, {
    headers: seeded.headers,
    data: { date_text: '3 MAY 1939' },
  });
  await page.getByRole('button', { name: /^Apply \d+ changes?$/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Your tree changed' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Apply \d+ changes?$/ })).toBeDisabled();
});

test('an override is not carried onto a newer local value, and a refused compare says why', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  const josiah = (await personByName(request, seeded.tree, 'Josiah'))!;
  const death = await eventDate(request, seeded.tree, josiah, 'DEAT');
  const edit = (date: string) =>
    request.patch(`/api/trees/${encodeURIComponent(seeded.tree)}/events/${death.id}`, {
      headers: seeded.headers,
      data: { date_text: date },
    });
  await edit('3 MAY 1939');
  await startReimport(page, seeded);
  // The user overrides their own edit...
  await card(page, 'Josiah Ashgrove')
    .getByRole('checkbox', { name: /Death: 3 May 1939 → 1940/ })
    .check();
  // ...then the date is edited again elsewhere.
  await edit('4 MAY 1939');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const banner = page.getByRole('alert').filter({ hasText: 'Your tree changed' });
  // A refused comparison (the tree is busy) explains itself and keeps the review.
  await page.route('**/api/reimports/*/refresh', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'conflict', message: 'Tree is busy (an import is running)' },
      }),
    }),
  );
  await banner.getByRole('button', { name: 'Compare again' }).click();
  await expect(
    page
      .getByRole('region', { name: /Notifications/ })
      .getByRole('listitem')
      .filter({ hasText: 'Tree is busy (an import is running)' }),
  ).toBeVisible();
  await expect(banner).toBeVisible();
  await page.unroute('**/api/reimports/*/refresh');
  await banner.getByRole('button', { name: 'Compare again' }).click();
  await expect(banner).toBeHidden();
  // The override was for 3 May; the user hasn't seen 4 May, so it starts unticked again.
  await expect(
    card(page, 'Josiah Ashgrove').getByRole('checkbox', { name: /Death: 4 May 1939 → 1940/ }),
  ).not.toBeChecked();
});

test('match percent and reasons say what differs, and why a new person is new', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  const edyth = '0 @I90@ INDI\n1 NAME Edyth /Ashgrove/\n1 SEX F\n1 BIRT\n2 DATE 1897\n';
  await startReimport(page, seeded, laterExport().replace('0 TRLR', `${edyth}0 TRLR`));
  // Thaddeus's birth date was refined: not a 100% match, and it says why.
  const thaddeus = card(page, 'Thaddeus Ashgrove');
  await expect(thaddeus.getByText(/different birth date/)).toBeVisible();
  await expect(thaddeus.getByText(/100% match/)).toHaveCount(0);
  // Edyth names her closest tree person and is not added by default, even in bulk.
  const card90 = card(page, 'Edyth Ashgrove');
  await expect(card90.getByText(/closest: Edith Ashgrove, \d+%/)).toBeVisible();
  const add = card90.getByRole('checkbox', { name: 'Add Edyth Ashgrove' });
  await expect(add).not.toBeChecked();
  await page.getByRole('button', { name: 'Accept all high-confidence' }).click();
  await expect(add).not.toBeChecked();
  // A genuinely new person says so, truthfully: nobody was close enough to compare.
  await expect(
    card(page, 'Noah Ashgrove').getByText('no close match in your tree', { exact: false }),
  ).toBeVisible();
  await expect(card(page, 'Noah Ashgrove').getByText(/closest:/)).toHaveCount(0);
});

test('the review lists what needs a decision first, filters by group, and formats dates', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  const josiah = (await personByName(request, seeded.tree, 'Josiah'))!;
  const death = await eventDate(request, seeded.tree, josiah, 'DEAT');
  await request.patch(`/api/trees/${encodeURIComponent(seeded.tree)}/events/${death.id}`, {
    headers: seeded.headers,
    data: { date_text: '3 MAY 1939' },
  });
  await startReimport(page, seeded);
  const groups = page.locator('[data-group]');
  await expect(groups.first()).toHaveAttribute('data-group', 'decide');
  const decide = page.getByRole('region', { name: /Needs your decision/ });
  // Marked by more than colour: an icon and the word, announced with the checkbox.
  const conflict = card(decide, 'Josiah Ashgrove').getByRole('checkbox', {
    name: 'Death: 3 May 1939 → 1940',
  });
  await expect(conflict).toBeVisible();
  await expect(conflict).toHaveAccessibleDescription(/^Conflict/);
  // The summary is about the whole export, and says which people aren't listed.
  await expect(page.getByRole('region', { name: 'Summary' })).toContainText(
    /\d+ matched \(\d+ unchanged, not listed\)/,
  );
  // The filter counts match the cards they show; empty groups get no filter.
  const filters = page.getByRole('group', { name: 'Filter the review' });
  for (const [label, id] of [
    ['Needs your decision', 'decide'],
    ['Changes', 'changes'],
    ['New people', 'new'],
    ['For information', 'info'],
  ] as const) {
    const button = filters.getByRole('button', { name: new RegExp(`^${label} \\d+$`) });
    const count = Number(/\d+$/.exec((await button.textContent())!)![0]);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toHaveAttribute('data-group', id);
    await expect(groups.first().locator('article[data-status]')).toHaveCount(count);
  }
  await filters.getByRole('button', { name: /^All \d+$/ }).click();
  await expect(groups).toHaveCount(4);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('the comparison page names the file and phase while it runs (#161)', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  // Hold the job at the compare phase, however fast the real one is. The page
  // reads the job again when the stream ends, so that read is held too.
  const held = (id: string) => ({
    id,
    kind: 'reimport',
    tree: seeded.tree,
    fileName: 'Ashgrove 2026.ged',
    createdTree: false,
    state: 'running',
    progress: { phase: 'compare', done: 0, total: 1 },
    result: null,
    error: null,
    cancelled: false,
  });
  await page.route('**/api/jobs/*/events', (route) => {
    const id = /jobs\/([^/]+)\/events/.exec(route.request().url())![1]!;
    void route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `event: state\ndata: ${JSON.stringify(held(id))}\n\n`,
    });
  });
  await page.route('**/api/jobs/*', (route) => {
    if (route.request().method() !== 'GET') return void route.continue();
    const id = /jobs\/([^/?#]+)/.exec(route.request().url())![1]!;
    void route.fulfill({ status: 200, contentType: 'application/json', json: held(id) });
  });
  await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), seeded.tree);
  await page.goto('/');
  await page.getByRole('button', { name: 'File' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Re-import updated export/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'Ashgrove 2026.ged',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(laterExport()),
  });
  await expect(
    page.getByRole('heading', { name: 'Comparing Ashgrove 2026.ged with your tree' }),
  ).toBeVisible();
  await expect(page.getByText('Comparing with your tree', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled();
});

test('a second re-import follows Ancestry for a value the first one set (#185)', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  const josiah = (await personByName(request, seeded.tree, 'Josiah'))!;
  const applied = () =>
    expect(
      page
        .getByRole('region', { name: /Notifications/ })
        .getByRole('listitem')
        .filter({ hasText: /Applied \d+ change/ })
        .last(),
    ).toBeVisible({ timeout: 30_000 });
  await startReimport(page, seeded);
  await page.getByRole('button', { name: /^Apply \d+ changes?$/ }).click();
  await applied();
  expect((await eventDate(request, seeded.tree, josiah, 'DEAT')).date_text).toBe('1940');
  // The next export changes it again; nobody edited it here, so it is offered ticked.
  await startReimport(page, seeded, laterExport().replace('2 DATE 1940', '2 DATE 1941'));
  const death = card(page, 'Josiah Ashgrove').getByRole('checkbox', { name: /Death: 1940 → 1941/ });
  await expect(death).toBeChecked();
  await page.getByRole('button', { name: /^Apply \d+ changes?$/ }).click();
  await applied();
  expect((await eventDate(request, seeded.tree, josiah, 'DEAT')).date_text).toBe('1941');
});

test("a renamed person's export name is offered as an alternate, saying so", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  const thaddeus = (await personByName(request, seeded.tree, 'Thaddeus'))!;
  const detail = (await (
    await request.get(`/api/trees/${encodeURIComponent(seeded.tree)}/people/${thaddeus}`)
  ).json()) as { names: { id: string }[] };
  const renamed = await request.patch(
    `/api/trees/${encodeURIComponent(seeded.tree)}/names/${detail.names[0]!.id}`,
    { headers: seeded.headers, data: { given: 'Thad' } },
  );
  expect(renamed.ok()).toBe(true);
  // Ancestry renamed him too, so both sides changed the name (#185).
  await startReimport(
    page,
    seeded,
    laterExport().replace(
      '1 NAME Thaddeus /Ashgrove/\n2 GIVN Thaddeus\n',
      '1 NAME Thaddeus James /Ashgrove/\n2 GIVN Thaddeus James\n',
    ),
  );
  const keep = card(page, 'Thad Ashgrove').getByRole('checkbox', {
    name: 'Also keep Thaddeus James Ashgrove as an alternate name',
  });
  await expect(keep).not.toBeChecked();
  await expect(
    card(page, 'Thad Ashgrove').getByText(
      'The export now calls this person Thaddeus James Ashgrove (it was Thaddeus Ashgrove); you renamed them Thad Ashgrove here. Tick to also keep Thaddeus James Ashgrove as an alternate name; Thad Ashgrove stays the primary name.',
    ),
  ).toBeVisible();
});

test('discarding a review changes nothing', async ({ page, request, baseURL }, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  await startReimport(page, seeded);
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL(/\/$/);
  const history = (await (
    await request.get(`/api/trees/${encodeURIComponent(seeded.tree)}/history`)
  ).json()) as { items: unknown[] };
  expect(history.items).toEqual([]);
});

test('cancelling the comparison keeps nothing and changes nothing', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  // Hold the progress stream so the page stays on the comparison, however fast it is.
  await page.route('**/api/jobs/*/events', () => {});
  await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), seeded.tree);
  await page.goto('/');
  await page.getByRole('button', { name: 'File' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Re-import updated export/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'Ashgrove 2026.ged',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(laterExport()),
  });
  await expect(page.getByRole('heading', { name: 'Starting the comparison' })).toBeVisible();
  const jobId = /\/reimport\/([^/?#]+)/.exec(page.url())![1]!;
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByText('Re-import cancelled. Your tree was not changed.', { exact: true }),
  ).toBeVisible();
  // Whether the job was stopped or had already finished, no review is left behind.
  // A worker job settles after its cancel (up to the grace period): wait for it.
  type Job = { state: string; result?: { reimportId: string } | null };
  const read = async () => (await (await request.get(`/api/jobs/${jobId}`)).json()) as Job;
  await expect
    .poll(async () => (await read()).state, { timeout: 10_000 })
    .toMatch(/^(completed|failed)$/);
  const job = await read();
  if (job.result?.reimportId) {
    expect((await request.get(`/api/reimports/${job.result.reimportId}`)).status()).toBe(404);
  } else {
    expect(job.state).toBe('failed');
  }
  const history = (await (
    await request.get(`/api/trees/${encodeURIComponent(seeded.tree)}/history`)
  ).json()) as { items: unknown[] };
  expect(history.items).toEqual([]);
});

test('the review screen has no accessibility violations', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  await startReimport(page, seeded);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('a large review is shown in pages, and bulk choices cover every page', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  const many = Array.from(
    { length: 150 },
    (_, i) => `0 @I${900 + i}@ INDI\n1 NAME Extra${i} /Newfield/\n1 BIRT\n2 DATE ${1900 + i}`,
  ).join('\n');
  await startReimport(page, seeded, laterExport().replace('0 TRLR', `${many}\n0 TRLR`));
  const cards = page.locator('article[data-status]');
  await expect(cards).toHaveCount(100);
  await expect(page.getByRole('button', { name: /Show 54 more/ })).toBeVisible();
  // Every default change counts, shown or not: 151 new people and the matched changes.
  const apply = page.getByRole('button', { name: /^Apply \d+ changes$/ });
  const total = Number(/\d+/.exec((await apply.textContent())!)![0]);
  expect(total).toBeGreaterThan(151);
  await page.getByRole('button', { name: /Show 54 more/ }).click();
  await expect(cards).toHaveCount(154);
  await expect(page.getByRole('button', { name: /Show \d+ more/ })).toHaveCount(0);
});

test('a review with nothing in a group offers no filter for it', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const seeded = await seed(request, baseURL!, testInfo);
  // Only a new person: no decisions, changes or information.
  const one = '0 @I90@ INDI\n1 NAME Quill /Vexbury/\n1 BIRT\n2 DATE 1950\n';
  await startReimport(page, seeded, SAMPLE.replace('0 TRLR', `${one}0 TRLR`));
  const filters = page.getByRole('group', { name: 'Filter the review' });
  await expect(filters.getByRole('button')).toHaveText(['All 1', 'New people 1']);
});
