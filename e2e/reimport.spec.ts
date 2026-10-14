import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
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

const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

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
    name: /Birth: Abt\. 1842 → 12 MAR 1842/,
  });
  await expect(birth).toBeChecked();
  await expect(card(page, 'Thaddeus Ashgrove')).toContainText(/\d+% match/);
  const deathChange = card(page, 'Josiah Ashgrove').getByRole('checkbox', {
    name: /Death: 3 MAY 1939 → 1940/,
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
  await expect(page).toHaveURL(/\/(tree|person)\//);
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
    card(page, 'Josiah Ashgrove').getByRole('checkbox', { name: /Death: 3 MAY 1939 → 1940/ }),
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
    .getByRole('checkbox', { name: /Death: 3 MAY 1939 → 1940/ })
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
  await startReimport(page, seeded);
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
  // A genuinely new person says so.
  await expect(
    card(page, 'Noah Ashgrove').getByText(/closest:|no one with a similar name/),
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
  const job = (await (await request.get(`/api/jobs/${jobId}`)).json()) as {
    state: string;
    result?: { reimportId: string } | null;
  };
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
  const cards = page.locator('section[data-status]');
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
