import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** WebKit only Tabs to buttons and links with Alt, like Safari's default setting. */
function tab(browserName: string, shift = false) {
  const mod = browserName === 'webkit' ? 'Alt+' : '';
  return `${shift ? 'Shift+' : ''}${mod}Tab`;
}

/** Each kitchen sink section is a region labelled by its component name. */
function section(page: Page, name: string) {
  return page.getByRole('region', { name, exact: true });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/design');
  await expect(page.getByRole('heading', { level: 1, name: 'Design system' })).toBeVisible();
});

test.describe('visual snapshots', () => {
  // Baselines are rendered on Linux (CI or `npm run e2e:snapshots` in the Playwright
  // Docker image) so local macOS runs skip rather than compare against another OS.
  test.skip(
    ({ browserName }) => browserName !== 'chromium' || process.platform !== 'linux',
    'Visual baselines are Chromium on Linux only',
  );

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`/design in ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      // The top bar names the open tree once it loads.
      await expect(page.getByRole('banner').getByText('Ashdown family')).toBeVisible({
        timeout: 15_000,
      });
      await page.evaluate(() => document.fonts.ready);
      // Full-page captures don't scroll, so scroll once to trigger lazy images.
      await page.evaluate(async () => {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight / 2) {
          window.scrollTo(0, y);
          await frame();
        }
        window.scrollTo(0, 0);
      });
      await expect
        .poll(() => page.evaluate(() => [...document.images].every((img) => img.complete)))
        .toBe(true);
      await expect(page.getByTestId('avatar-broken')).toHaveAttribute(
        'data-fallback',
        'silhouette',
      );
      await expect(page).toHaveScreenshot(`design-${colorScheme}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
      });
    });
  }
});

test('lists every design system component', async ({ page }) => {
  const names = [
    'Button',
    'IconButton',
    'Toolbar',
    'Tabs',
    'Popover',
    'Dialog',
    'Tooltip',
    'Toast',
    'Input',
    'Textarea',
    'DateInput',
    'ConfirmDialog',
    'Select',
    'Combobox',
    'Checkbox',
    'Switch',
    'Skeleton',
    'EmptyState',
    'Panel',
    'Avatar',
    'LifespanText',
    'PersonCard',
    'QuickViewPopover',
    'TagBadge',
    'TimelineItem',
    'RelationshipList',
    'RelationshipChart',
    'SourceItem',
    'GenerationLabel',
    'TreeToolbar',
    'Minimap',
    'CommandPalette',
  ];
  for (const name of names) await expect(section(page, name)).toBeVisible();
});

test('buttons expose disabled and loading states', async ({ page }) => {
  const buttons = section(page, 'Button');
  await expect(buttons.getByRole('button', { name: 'Disabled' }).first()).toBeDisabled();
  const loading = buttons.getByRole('button', { name: 'Saving' });
  await expect(loading).toHaveAttribute('aria-busy', 'true');
  await expect(loading).toBeDisabled();
});

test('visible focus ring on keyboard focus', async ({ page, browserName }) => {
  const primary = section(page, 'Button').getByRole('button', { name: 'Primary' }).first();
  await primary.focus();
  await page.keyboard.press(tab(browserName, true));
  await page.keyboard.press(tab(browserName));
  await expect(primary).toBeFocused();
  const outline = await primary.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe('solid');
});

test('icon button pressed state and tooltip with shortcut', async ({ page, browserName }) => {
  const region = section(page, 'IconButton');
  const toggle = region.getByRole('button', { name: 'Show minimap' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // Radix tooltips open on keyboard (focus-visible) focus, so arrive by Tab.
  await region.getByRole('button', { name: 'Search' }).focus();
  await page.keyboard.press(tab(browserName, true));
  await expect(region.getByRole('button', { name: 'Zoom in' })).toBeFocused();
  await expect(page.getByRole('tooltip')).toContainText('Zoom in');
  await expect(page.getByRole('tooltip')).toContainText('+');
});

test('toolbar moves focus with arrow keys', async ({ page }) => {
  const toolbar = section(page, 'Toolbar').getByRole('toolbar', { name: 'Demo toolbar' });
  const buttons = toolbar.getByRole('button');
  await buttons.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(buttons.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(buttons.last()).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(buttons.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(buttons.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(buttons.nth(0)).toBeFocused();
});

test('tabs switch with the keyboard', async ({ page }) => {
  const region = section(page, 'Tabs');
  await region.getByRole('tab', { name: 'Facts' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(region.getByRole('tab', { name: 'Gallery' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(region.getByRole('tabpanel')).toContainText('No photos yet');
});

test('popover opens, closes on Escape and restores focus', async ({ page }) => {
  const trigger = section(page, 'Popover').getByRole('button', { name: 'Open popover' });
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'Filter events' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Filter events' })).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('dialog traps focus and restores it on close', async ({ page, browserName }) => {
  const trigger = section(page, 'Dialog').getByRole('button', { name: 'Open dialog' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Edit person' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Given names' })).toBeFocused();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(tab(browserName));
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('tooltip appears on keyboard focus', async ({ page, browserName }) => {
  const trigger = section(page, 'Tooltip').getByRole('button', { name: 'Hover for tooltip' });
  // Radix closes tooltips on scroll, so settle scrolling before tabbing in.
  await trigger.evaluate(async (el) => {
    el.scrollIntoView({ block: 'center' });
    // Let the scroll event fire before the tooltip opens.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await trigger.focus();
  await page.keyboard.press(tab(browserName, true));
  await page.keyboard.press(tab(browserName));
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('tooltip')).toContainText('Tooltips describe controls');
});

test('toast announces and dismisses', async ({ page }) => {
  await section(page, 'Toast').getByRole('button', { name: 'Show toast' }).click();
  const toasts = page.getByRole('region', { name: /Notifications/ }).getByRole('listitem');
  const toast = toasts.filter({ hasText: 'Changes saved' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await expect(toast).toBeHidden();

  await section(page, 'Toast').getByRole('button', { name: 'Show error toast' }).click();
  await expect(toasts.filter({ hasText: 'Could not save' })).toBeVisible();
});

test('inputs show labels, hints and errors', async ({ page }) => {
  const region = section(page, 'Input');
  const given = region.getByRole('textbox', { name: 'Given names' });
  await given.fill('Eleanor');
  await expect(given).toHaveValue('Eleanor');
  const surname = region.getByRole('textbox', { name: 'Surname' });
  await expect(surname).toHaveAttribute('aria-invalid', 'true');
  await expect(surname).toHaveAccessibleDescription('Surname is required');
  await expect(region.getByRole('textbox', { name: 'Record id' })).toBeDisabled();

  const notes = section(page, 'Textarea').getByRole('textbox', { name: 'Notes', exact: true });
  await notes.fill('Emigrated in spring.');
  await expect(notes).toHaveValue('Emigrated in spring.');
});

test('date input previews how a date is read', async ({ page }) => {
  const region = section(page, 'DateInput');
  await expect(region.getByTestId('date-preview').nth(0)).toHaveText('abt. 1890 · about');
  await expect(region.getByTestId('date-preview').nth(1)).toContainText(
    'could also be read day first',
  );
  await expect(region.getByTestId('date-preview').nth(2)).toContainText('Not a recognized date');
  const empty = region.getByRole('textbox', { name: 'Empty' });
  await empty.fill('bef 1900');
  await expect(region.getByTestId('date-preview').nth(3)).toHaveText('bef. 1900 · before');
  await expect(empty).toHaveAccessibleDescription(/bef\. 1900/);
});

test('confirm dialog focuses Cancel and confirms on demand', async ({ page }) => {
  const region = section(page, 'ConfirmDialog');
  await region.getByRole('button', { name: 'Delete record' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this record?' });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(region.getByRole('status')).toHaveText('');
  await region.getByRole('button', { name: 'Delete record' }).click();
  await dialog.getByRole('button', { name: 'Delete record' }).click();
  await expect(region.getByRole('status')).toHaveText('Deleted');
});

test('select picks an option with the keyboard', async ({ page }) => {
  const region = section(page, 'Select');
  const trigger = region.getByRole('combobox', { name: 'Event type' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  // Keys only: a click on an item-aligned option far down this long page could
  // wait forever in WebKit, which keeps the page scroll-locked while it is open.
  await expect(page.getByRole('option', { name: 'Birth' })).toBeFocused();
  // The list can drop a key pressed while it is still positioning, so step until
  // Death has focus; past it is only the disabled Burial, so extra presses stay put.
  const death = page.getByRole('option', { name: 'Death' });
  await expect(async () => {
    await page.keyboard.press('ArrowDown');
    await expect(death).toBeFocused({ timeout: 250 });
  }).toPass();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(trigger).toContainText('Death');
  await expect(region.getByRole('combobox', { name: 'Disabled select' })).toBeDisabled();
});

test('combobox options stay on screen and scroll on a short window', async ({ page }) => {
  const region = section(page, 'Combobox');
  const trigger = region.getByRole('combobox', { name: 'Place', exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 1024, height: 160 });
  await trigger.click();
  const options = page.getByRole('option');
  await expect(options.first()).toBeVisible();
  const list = page.getByRole('listbox');
  const box = (await list.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(160);
  expect(await list.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  // The last place can be reached with the keyboard and comes into view.
  const count = await options.count();
  for (let i = 1; i < count; i++) await page.keyboard.press('ArrowDown');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  await expect(options.last()).toBeInViewport();
  await page.keyboard.press('Escape');
});

test('combobox filters and selects', async ({ page }) => {
  const region = section(page, 'Combobox');
  const trigger = region.getByRole('combobox', { name: 'Place', exact: true });
  await trigger.click();
  await page.keyboard.type('phil');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(trigger).toContainText('Philadelphia, PA');
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.keyboard.type('zzz');
  await expect(page.getByText('No matching places')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('checkbox and switch toggle', async ({ page }) => {
  const box = section(page, 'Checkbox').getByRole('checkbox', { name: 'Show living people' });
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(box).toBeChecked();
  await expect(
    section(page, 'Checkbox').getByRole('checkbox', { name: 'Some sources selected' }),
  ).toHaveJSProperty('indeterminate', true);

  const sw = section(page, 'Switch').getByRole('switch', { name: 'Show minimap' });
  await expect(sw).not.toBeChecked();
  await sw.press('Space');
  await expect(sw).toBeChecked();
});

test('avatar falls back when a photo fails to load', async ({ page }) => {
  const region = section(page, 'Avatar');
  const photo = region.getByRole('img', { name: 'Photo of Eleanor Whitcombe' }).first();
  await expect(photo).toHaveAttribute('loading', 'lazy');
  await expect(photo).toHaveAttribute('decoding', 'async');
  const broken = region.getByTestId('avatar-broken');
  // Lazy images only load (and fail) near the viewport.
  await broken.scrollIntoViewIfNeeded();
  await expect(broken).toHaveAttribute('data-fallback', 'silhouette');
  await expect(broken).toHaveAccessibleName('Rafferty Quill, male');
});

test('lifespan text formats dates', async ({ page }) => {
  const region = section(page, 'LifespanText');
  for (const text of ['1911–1957', '1947–Living', 'abt. 1890–1955', 'b. 1820', 'd. 1880']) {
    await expect(region.getByText(text, { exact: true })).toBeVisible();
  }
});

test('person cards convey sex without color and expose states', async ({ page }) => {
  const region = section(page, 'PersonCard');
  const card = region.getByRole('button', { name: /Thaddeus Marlowe, male, 1911–1957/ }).first();
  await expect(card).toBeVisible();
  await expect(region.getByRole('button', { name: /female/ }).first()).toBeVisible();
  await expect(region.getByRole('button', { name: /focus person/ }).first()).toBeVisible();
  await expect(region.getByRole('button', { name: /duplicate/ }).first()).toBeVisible();
  await expect(region.getByRole('button', { name: /–Living/ }).first()).toBeVisible();
  await expect(
    region.getByRole('button', { name: /^Private person, private/ }).first(),
  ).toBeVisible();
  await expect(region.getByRole('button', { name: /selected/ }).first()).toBeVisible();
});

test('quick view popover shows details and actions', async ({ page }) => {
  const region = section(page, 'QuickViewPopover');
  await region.getByRole('button', { name: /Eleanor Whitcombe/ }).click();
  const popover = page.getByRole('dialog', { name: 'Eleanor Whitcombe' });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Born 5 Sep 1911');
  await expect(popover).toContainText('Philadelphia, PA');
  await popover.getByRole('button', { name: 'Make focus' }).click();
  await expect(region.getByRole('status')).toHaveText('Make focus: Eleanor Whitcombe');
  await expect(popover).toBeHidden();

  // One shared popover: opening another card swaps the person, Escape returns focus to the card.
  const thaddeusCard = region.getByRole('button', { name: /Thaddeus Marlowe/ });
  await thaddeusCard.click();
  await expect(thaddeusCard).toHaveAttribute('aria-expanded', 'true');
  const other = page.getByRole('dialog', { name: 'Thaddeus Marlowe' });
  await expect(other).toContainText('Cork, Ireland');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(other).toBeHidden();
  await expect(thaddeusCard).toBeFocused();

  await region.getByRole('button', { name: /Eleanor Whitcombe/ }).click();
  await page
    .getByRole('dialog', { name: 'Eleanor Whitcombe' })
    .getByRole('button', { name: 'Edit' })
    .click();
  await expect(region.getByRole('status')).toHaveText('Edit: Eleanor Whitcombe');

  await region.getByRole('button', { name: /Eleanor Whitcombe/ }).click();
  await page
    .getByRole('dialog', { name: 'Eleanor Whitcombe' })
    .getByRole('link', { name: 'Profile' })
    .click();
  await expect(page).toHaveURL(/\/person\/I1(\?tree=[^&]*)?$/);
});

test('timeline, relationships and sources render their variants', async ({ page }) => {
  const timeline = section(page, 'TimelineItem');
  await expect(timeline.getByText('alternate', { exact: true })).toBeVisible();
  await expect(timeline.getByText('Family event', { exact: true }).first()).toBeAttached();

  const rel = section(page, 'RelationshipList');
  await expect(rel.getByRole('heading', { name: 'Parents' })).toBeVisible();
  await rel.getByRole('button', { name: 'Add parent' }).click();
  await expect(rel.getByRole('status')).toHaveText('Add parent');
  await rel.getByRole('link', { name: /Wilhelmina Ostrander/ }).click();
  await expect(page).toHaveURL(/\/person\/I3(\?tree=[^&]*)?$/);
});

test('source item links to the external record', async ({ page }) => {
  const region = section(page, 'SourceItem');
  const link = region.getByRole('link', { name: /View record/ }).first();
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  await expect(region.getByText('Primary evidence')).toBeVisible();
});

test('tree toolbar buttons and layout menu', async ({ page }) => {
  const region = section(page, 'TreeToolbar');
  const toolbar = region.getByRole('toolbar', { name: 'Tree tools' });
  for (const name of [
    'Find in tree',
    'Go to home person',
    'Zoom in',
    'Zoom out',
    'Fit to screen',
  ]) {
    await toolbar.getByRole('button', { name }).click();
    await expect(region.getByRole('status')).toHaveText(name);
  }
  await toolbar.getByRole('button', { name: /Layout/ }).click();
  await page.getByRole('menuitemradio', { name: 'Pedigree' }).click();
  await expect(region.getByRole('status')).toHaveText('Layout: pedigree');
});

test('minimap navigates by click and keyboard and can be dismissed', async ({ page }) => {
  const region = section(page, 'Minimap');
  const map = region.getByRole('application', { name: 'Minimap' });
  const box = await map.boundingBox();
  await map.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
  await expect(region.getByRole('status')).toContainText('Viewport centered at');
  const before = await region.getByRole('status').textContent();
  await map.focus();
  await page.keyboard.press('ArrowRight');
  await expect(region.getByRole('status')).not.toHaveText(before!);

  // Drag pans continuously.
  await page.mouse.move(box!.x + 10, box!.y + 10);
  await page.mouse.down();
  await page.mouse.move(box!.x + 40, box!.y + 30);
  await page.mouse.up();

  await region.getByRole('button', { name: 'Hide minimap' }).click();
  await expect(map).toBeHidden();
  await region.getByRole('button', { name: 'Show minimap' }).click();
  await expect(map).toBeVisible();
});

test('command palette can be opened from the design page', async ({ page }) => {
  await section(page, 'CommandPalette')
    .getByRole('button', { name: 'Open command palette' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('skeleton, empty state and panel render', async ({ page }) => {
  await expect(section(page, 'Skeleton').getByTestId('skeleton').first()).toBeVisible();
  await expect(
    section(page, 'EmptyState').getByRole('heading', { name: 'No sources yet' }),
  ).toBeVisible();
  await expect(section(page, 'Panel').getByRole('heading', { name: 'Sources' })).toBeVisible();
  await expect(section(page, 'TagBadge').getByText('Immigrant')).toBeVisible();
  await expect(section(page, 'GenerationLabel').getByText('Grandparents')).toBeVisible();
});

test('reduced motion disables transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const duration = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--oa-duration-base').trim(),
  );
  expect(duration).toMatch(/^0m?s$/);
  // global.css removes transitions outright, which is what components rely on.
  const transition = await section(page, 'Button')
    .getByRole('button', { name: 'Primary' })
    .first()
    .evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(transition).toBe('none');
});

/** WCAG relative luminance contrast between two `rgb()` colors. */
function contrast(a: string, b: string): number {
  const lum = (color: string) => {
    const [r, g, bl] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`person card focus ring is visible on the canvas in ${colorScheme}`, async ({
    page,
    browserName,
  }) => {
    await page.emulateMedia({ colorScheme });
    const region = section(page, 'PersonCard');
    const cards = region.getByRole('button');
    await cards.nth(1).focus();
    await page.keyboard.press(tab(browserName, true));
    await expect(cards.first()).toBeFocused();
    const ring = await cards.first().evaluate((el) => {
      const style = getComputedStyle(el);
      const canvas = el.closest('[data-surface="canvas"]')!;
      return {
        color: style.outlineColor,
        width: style.outlineWidth,
        offset: style.outlineOffset,
        canvas: getComputedStyle(canvas).backgroundColor,
      };
    });
    expect(ring.width).toBe('2px');
    // Detached ring: focus never looks like selection (inset ring) or the focus person (attached ring).
    expect(ring.offset).toBe('4px');
    expect(contrast(ring.color, ring.canvas)).toBeGreaterThanOrEqual(3);

    const selected = region.getByRole('button', { name: /selected/ }).first();
    const selectedStyle = await selected.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(selectedStyle).toContain('inset');
  });
}

test('relationship chart switches between paths', async ({ page }) => {
  const region = section(page, 'RelationshipChart');
  const list = () => region.getByRole('list', { name: /^Relationship path/ });
  await expect(list().getByRole('listitem')).toHaveCount(6);
  await region.getByRole('combobox', { name: 'Path (2)' }).click();
  await page.getByRole('option', { name: 'nephew through Thaddeus Marlowe' }).click();
  await expect(list()).toHaveAccessibleName('Relationship path: nephew through Thaddeus Marlowe');
  await expect(list().getByRole('listitem')).toHaveCount(4);
});
