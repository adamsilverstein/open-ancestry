# open-ancestry Design System

The look: a calm, archival workspace. Warm paper neutrals in light mode, a deep slate canvas for the tree (echoing Ancestry's dark tree canvas), a serif display face for people's names, and a precise sans for UI. Content (people, photos, dates) is the hero; chrome stays quiet.

Implementation: CSS custom properties in `apps/web/src/design/tokens.css`, consumed by CSS Modules. No runtime CSS-in-JS. Accessible primitives (dialog, popover, tabs, combobox) come from Radix UI; everything is styled with our tokens. The `/design` route renders every component in every state and is snapshot-tested.

## Principles

1. **Speed is a feature.** No layout shift, skeletons sized to final content, transitions under 200ms, nothing animates on the critical path.
2. **People first.** Names, faces and dates get the largest type and highest contrast. Controls recede until hovered or focused.
3. **Never color alone.** Sex, relationship type and status are conveyed with icon or text as well as color. WCAG 2.2 AA contrast minimum everywhere.
4. **Keyboard complete.** Every action reachable by keyboard; visible focus ring on everything.
5. **Uncertainty is visible.** Approximate dates (`abt. 1890`), alternate facts, and unsourced facts have distinct, consistent treatments.

## Tokens

### Color

Semantic tokens only in components; raw palette stays in tokens.css.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--oa-bg` | `#FAF8F4` | `#14171C` | App background |
| `--oa-surface` | `#FFFFFF` | `#1C2027` | Panels, cards |
| `--oa-surface-sunken` | `#F2EFE8` | `#101318` | Wells, shaded timeline rows |
| `--oa-canvas` | `#3D424A` | `#22262D` | Tree canvas |
| `--oa-canvas-line` | `#8A9099` | `#5C636D` | Tree connectors |
| `--oa-text` | `#1D232B` | `#ECEEF1` | Primary text |
| `--oa-text-muted` | `#5B6470` | `#A3ABB6` | Secondary text |
| `--oa-border` | `#E2DED5` | `#2E343D` | Hairlines |
| `--oa-accent` | `#2F6F4E` | `#5FB98A` | Primary actions, links, focus (a leaf green nod) |
| `--oa-accent-contrast` | `#FFFFFF` | `#0D1F16` | Text on accent |
| `--oa-focus` | `#2F6F4E` | `#7FD3A8` | 2px focus ring + 2px offset |
| `--oa-person-male` | `#5B7FA6` | `#7FA3CB` | Card top stripe + silhouette tint (with icon) |
| `--oa-person-female` | `#C0664A` | `#E08A6E` | Card top stripe + silhouette tint (with icon) |
| `--oa-person-unknown` | `#7B7F87` | `#9AA0A8` | Unknown/other sex |
| `--oa-warning` | `#B7791F` | `#E0A84A` | Data warnings (tree checker) |
| `--oa-danger` | `#B3261E` | `#F2867E` | Destructive actions |
| `--oa-info` | `#2B6CB0` | `#76A9E0` | Info, sources |

Supporting tokens added during implementation:

| Token | Light | Dark | Use |
|---|---|---|---|
| `--oa-surface-hover` | `#F5F2EC` | `#242932` | Hover fill for rows, ghost buttons |
| `--oa-surface-selected` | `#E3EFE8` | `#1E3328` | Selected cards, highlighted options |
| `--oa-border-strong` | `#857F73` | `#6E7682` | Control outlines (inputs, secondary buttons); 3:1 on surfaces (WCAG 1.4.11) |
| `--oa-accent-hover` | `#255A3F` | `#77C79C` | Primary button hover |
| `--oa-canvas-text` / `-muted` | `#ECEEF1` / `#C9CED6` | `#ECEEF1` / `#A3ABB6` | Text drawn on the tree canvas (generation labels) |
| `--oa-danger-contrast` | `#FFFFFF` | `#14171C` | Text on danger |
| `--oa-scrim` | 40% ink | 60% black | Dialog overlay |
| `--oa-elevated-border` | transparent | `#3A414B` | Border on popovers/dialogs (replaces shadows in dark) |

`--oa-warning` is 3.4:1 on light surfaces, so it is for icons and borders only; pair it with `--oa-text` for message text.

Tag colors: an 8-color categorical set, each at least 4.5:1 on `--oa-surface` and `--oa-bg` in both themes:

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Light | `#0F766E` | `#1D4ED8` | `#6D28D9` | `#A21CAF` | `#B91C1C` | `#B45309` | `#4D7C0F` | `#475569` |
| Dark | `#2DD4BF` | `#93C5FD` | `#C4B5FD` | `#F0ABFC` | `#FCA5A5` | `#FCD34D` | `#BEF264` | `#CBD5E1` |

### Theming

Every color token is a `light-dark()` pair, so the active scheme is decided by the CSS `color-scheme` property alone:

- `:root` has `color-scheme: light dark`, so the app follows the OS (`prefers-color-scheme`) with no JavaScript.
- `<html data-theme="light|dark">` pins a scheme. The top bar toggle (and the command palette action) flips what is on screen; landing back on the OS scheme removes the override instead of storing it, so the app keeps following the OS. The override lives in `localStorage` under `oa-theme`.
- `public/theme-init.js` is a tiny blocking classic script in `<head>` that applies the stored override before first paint. It is an external file, not inline, so a strict `script-src 'self'` CSP needs no exceptions.
- Canvas code that needs a token's resolved color reads it through a real color property (set `style.color = var(--token)`, read `getComputedStyle().color`); `getPropertyValue('--token')` returns the unresolved `light-dark()` text.

```
OS preference ──> color-scheme: light dark ──┐
                                             ├─> light-dark(a, b) picks a or b
data-theme="dark" ──> color-scheme: dark ────┘
```

### Typography

Self-hosted variable fonts (no runtime network requests). `src/design/fonts.css` declares only the latin and latin-ext subsets from `@fontsource-variable`, with `font-display: swap`; the build preloads the Inter latin subset (`preloadUiFont` in `vite.config.ts`). `body` sets `font-size-adjust: from-font` so the fallback occupies the same space while fonts load.

Font tokens are `font` shorthands (`font: var(--oa-text-sm)`), so set `font-weight` after them.

| Token | Value | Use |
|---|---|---|
| `--oa-font-sans` | `"Inter Variable", system-ui, sans-serif` | UI |
| `--oa-font-serif` | `"Source Serif 4 Variable", Georgia, serif` | Person names on person page, page titles |
| `--oa-font-mono` | `ui-monospace, "SF Mono", monospace` | GEDCOM raw view, ids |
| `--oa-text-xs` | 12px / 16px | Card dates, captions |
| `--oa-text-sm` | 13px / 18px | Dense UI, card names |
| `--oa-text-md` | 15px / 22px | Body |
| `--oa-text-lg` | 18px / 26px | Section titles |
| `--oa-text-xl` | 24px / 30px | Panel titles |
| `--oa-text-display` | 36px / 42px serif | Person page name |

Numerals: `font-variant-numeric: tabular-nums` for dates and ages.

### Space, radius, elevation, motion

- Space scale (4px base): `--oa-space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-5` 24, `-6` 32, `-7` 48, `-8` 64.
- Radius: `--oa-radius-sm` 4 (cards on canvas), `-md` 8 (panels, inputs), `-lg` 12 (dialogs), `-full`.
- Elevation: `--oa-shadow-1` (cards), `-2` (popovers), `-3` (dialogs). In dark mode shadows are replaced by lighter surface + border.
- Motion: `--oa-duration-fast` 120ms, `-base` 180ms, easing `--oa-ease` `cubic-bezier(.2,.0,.0,1)`. Under `prefers-reduced-motion` the duration tokens become 0, transitions are removed (`transition: none`, not a tiny duration, which would make every property animate) and animations end immediately. Tree re-focus uses a 180ms transform tween, never relayout animation.
- Breakpoints: `sm` 640, `md` 960, `lg` 1280. Person page goes 3 columns at `lg`, 2 at `md`, 1 below.

## Components

Code: `apps/web/src/components/<Name>/<Name>.tsx` + `<Name>.module.css`, re-exported from `components/index.ts`. Shared types live in `src/lib` (`PersonSummary`, `LifeDate`, `Sex`, `TagColor`). Every component below is on `/design` in every state.

| Component | Key props | Notes |
|---|---|---|
| `PersonCard` | `person: PersonSummary`, `size` (`compact` 96x120 / `regular` 120x150), `selected`, `focusPerson`, `duplicate`, `isPrivate`, plus button props | Top stripe colored by sex + sex icon badge on the avatar. States: hover, focus ring, selected (accent outline + tint), focus person (raised + 2px ring outside the box, bold name), private/living (lock, "Private", no dates), duplicate (dashed border + link icon). Badges: tag dots, has-sources. Every state is also in the accessible name (`personCardLabel`). Forwards refs, so it can be a popover trigger. |
| `Avatar` | `name`, `sex`, `src`, `size` (24/40/64/120), `fallback` (`silhouette`/`initials`), `decorative` | Photo is `loading="lazy" decoding="async"` with fixed width/height; falls back on error. Silhouette shows a Mars/Venus/person icon tinted by sex. |
| `LifespanText` | `birth`, `death` (`LifeDate`), `living` | `1911–1957`, `1947–Living`, `abt. 1890–1955`, `b. 1820`, `d. 1880`. Tabular numerals. Formatting in `lib/lifespan.ts`. |
| `QuickViewPopover` | `person`, `birth`/`death` (`{ date, place }`), `onMakeFocus`, `onEdit`, `children` (trigger) | Avatar, serif name, born/died lines, Profile (link to `/person/$id`), Make focus, Edit. Actions close the popover. |
| `TreeToolbar` | `layout`, `onLayoutChange`, `onFind`, `onHome`, `onZoomIn`, `onZoomOut`, `onFit` | Vertical `Toolbar` of IconButtons with tooltips and shortcuts (`L`, `F`, `H`, `+`, `-`, `0`); layout is a radio menu (family, pedigree, descendants, fan). The tree view binds the shortcuts. |
| `Minimap` | `nodes` (rects + sex), `bounds`, `viewport`, `onNavigate(center)`, `onDismiss`, `width`, `height` | Canvas overview with the viewport rectangle; click or drag to move, arrow keys pan by a quarter viewport. Redraws on theme change. |
| `GenerationLabel` | `children` | Muted uppercase caption for the canvas. |
| `TimelineItem` | `year`, `age`, `title`, `date`, `place`, `sourceCount`, `variant` (`own`/`family`/`alternate`), `actions` | Renders an `<li>`; wrap in `<ol>`. Family events: sunken row + people icon + hidden "Family event" text. Alternate: indented, dotted rule, "alternate" chip. Unsourced: muted italic "No sources". |
| `RelationshipList` | `groups: { title, people, onAdd?, addLabel? }[]`, `headingLevel` | Labelled sections with person rows (avatar, name, lifespan) that link to `/person/$id`. |
| `SourceItem` | `title`, `citation`, `quality` (GEDCOM QUAY 0-3), `externalUrl`, `externalLabel` | Quality chip (dashed when weak), external link opens in a new tab with `rel="noreferrer noopener"`. |
| `TagBadge` | `label`, `color` (1-8), `variant` (`badge`/`dot`) | Dot variant is a labelled image for dense spots. |
| `CommandPalette` | `open`, `onOpenChange`, `groups: { heading, items: PaletteAction[] }[]`, `onQueryChange` | Radix dialog + cmdk, substring filtering on label and keywords, "No results" empty state. Restores focus to whatever was focused before it opened. The shell wires Cmd/Ctrl-K and app actions; people search plugs in via `onQueryChange`. |
| `Button` | `variant` (primary, secondary, ghost, danger), `size` (sm/md), `loading`, `iconStart`, `iconEnd` | `loading` disables and sets `aria-busy`. |
| `IconButton` | `label` (required), `icon`, `size`, `variant` (ghost/secondary/canvas), `pressed`, `shortcut`, `tooltip`, `tooltipSide` | Label is the accessible name and the tooltip. `IconButtonBase` is the same button without a tooltip, for initial-bundle code. |
| `Toolbar` | `label`, `orientation` | ARIA toolbar with roving tabindex: one Tab stop, arrows/Home/End move. |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | Radix Tabs props | Active tab: weight + underline, not color alone. |
| `Popover`, `PopoverTrigger`, `PopoverContent` (`label`), `PopoverClose`, `PopoverAnchor` | Radix Popover props | Content is a labelled dialog. |
| `Dialog` | `title`, `hideTitle`, `description`, `trigger`, `footer`, `size` (sm/md/lg), `open`, `onOpenChange` | Focus trapped, initial focus on the first field (close button is last in DOM order), restored on close. `DialogClose` wraps footer buttons. |
| `Tooltip` | `content`, `shortcut`, `side`, `children` | Opens on hover and keyboard focus. Self-contained provider; `TooltipProvider` optional for groups. |
| `ToastProvider`, `useToast()` | `toast({ title, description, variant: info/error, duration })` | Icon + colored edge per variant. |
| `Input`, `Textarea` | `label`, `hint`, `error`, plus native props | Shared `Field` wiring: label, `aria-describedby` for hint and error, `aria-invalid`; error has an icon. |
| `Select` | `label`, `options: { value, label, disabled? }[]`, `value`, `onValueChange`, `placeholder`, `disabled` | Radix Select. |
| `Combobox` | `label`, `options`, `value`, `onValueChange`, `placeholder`, `searchLabel`, `emptyText`, `disabled` | Button trigger (`role="combobox"`) opening a filterable cmdk list in a popover. |
| `Checkbox` | `label`, `description`, `indeterminate`, native props | Native input with `accent-color`. |
| `Switch` | `label`, native props | Native checkbox with `role="switch"`; state shown by knob position. |
| `Menu`, `MenuTrigger`, `MenuContent`, `MenuItem`, `MenuRadioGroup`, `MenuRadioItem`, `MenuSeparator` | Radix DropdownMenu props | Used by the File menu and the layout switch. |
| `Skeleton` | `width`, `height`, `shape` (text/rect/circle) | Decorative (`aria-hidden`); the container sets `aria-busy`. Size to the final content. |
| `EmptyState` | `icon`, `title`, `level` (1-3), `description`, `action` | `level={1}` when the empty state is the page (serif title). |
| `Panel` | `title`, `actions`, `variant` (raised/sunken), `headingLevel` | Titled panels are labelled regions. |
| `DateInput` | | Deferred to F12 (editing), where the date parser from `packages/core` lands. |

Hover and focus can be forced for screenshots with `data-demo-hover` / `data-demo-focus` on Button, IconButton, Input and PersonCard; only `/design` uses them.

### Performance rules

- Initial JS budget: 150 kB gzip for the entry chunk plus its static imports, enforced in CI by `npm run size` (`scripts/check-bundle-size.ts`, reads the Vite manifest). It is about 120 kB today.
- Routes other than `/` are lazy (`lazyRouteComponent`). The command palette and File menu are lazy chunks; the palette is prefetched on idle.
- Code on the initial bundle (app shell, home page) imports components from their own files, not the barrel, and avoids `Tooltip`, `Menu`, `Popover` and `Select` (they pull in the positioning library). `IconButtonBase` exists for this.
- `apps/web/package.json` declares `"sideEffects": ["**/*.css"]` so unused components tree-shake.

### Testing

- `/design` is the kitchen sink. `e2e/design.spec.ts` exercises every component's states and keyboard behavior and takes full-page visual snapshots in light and dark.
- Visual baselines are Chromium on Linux only (`e2e/__screenshots__`), matching the ubuntu CI runner; other platforms skip the comparison. Regenerate them with `npm run e2e:snapshots`, which runs the suite in the official Playwright Docker image (requires Docker).
- `e2e/a11y.spec.ts` runs axe on every route, and on the open command palette, in both themes.

## Layout patterns

- **App shell:** skip link, 48px sticky top bar (home link, tree name, Find with the Cmd/Ctrl-K hint, File menu with import/export, theme toggle), then `<main id="main">`. Cmd/Ctrl-K toggles the command palette from anywhere.
- **Tree page:** full-bleed canvas, left floating toolbar, bottom-left minimap, quick view popovers anchored to cards.
- **Person page:** header band on `--oa-canvas` (avatar 120, serif name, birth/death, relationship to home, tags, Edit), tab bar, then the three-column Facts grid (Timeline 1.6fr, Sources 1fr, Relationships 1fr).

## Content style

- Dates as stored by the user, normalized for display to `D Mon YYYY` (`5 Sep 1941`), with qualifiers abbreviated (`abt.`, `bef.`, `aft.`, `bet. 1890 and 1895`).
- Places shown shortest-first on cards (`Philadelphia, PA`), full on the person page.
- Living people: "Living" instead of a death year.
