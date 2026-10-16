# open-ancestry Design System

The look: a calm, archival workspace. Warm paper neutrals in light mode, a deep slate canvas for the tree (echoing Ancestry's dark tree canvas), a serif display face for people's names, and a precise sans for UI. Content (people, photos, dates) is the hero; chrome stays quiet.

Implementation: CSS custom properties in `apps/web/src/design/tokens.css`, consumed by CSS Modules. No runtime CSS-in-JS. Accessible primitives (dialog, popover, tabs, combobox) come from Radix UI; everything is styled with our tokens. The `/design` route renders every component in every state and is snapshot-tested.

## Principles

1. **Speed is a feature.** No layout shift, skeletons sized to final content, transitions under 200ms, nothing animates on the critical path.
2. **People first.** Names, faces and dates get the largest type and highest contrast. Controls recede until hovered or focused.
3. **Never color alone.** Sex, relationship type and status are conveyed with icon or text as well as color. WCAG 2.2 AA contrast minimum everywhere.
4. **Keyboard complete.** Every action reachable by keyboard; visible focus ring on everything.
   Touch targets are 44 × 44 at the default zoom and above, and at least 44 wide by 24 tall (WCAG 2.5.8) when zoomed out, where taller would cover a card.
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
| `--oa-focus` | `#2F6F4E` | `#7FD3A8` | 2px focus ring + 2px offset. Resolves to `--oa-focus-surface` or `--oa-focus-canvas` depending on the surface (see below) |
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
| `--oa-focus-surface` | `#2F6F4E` | `#7FD3A8` | Focus color on bg and surfaces (5.6:1+) |
| `--oa-focus-canvas` | `#7FD3A8` | `#7FD3A8` | Focus color on the tree canvas (5.7:1 light, 8.5:1 dark); the surface green is only 1.7:1 there |
| `--oa-focus-width` | `2px` | | Write rings as `outline: var(--oa-focus-width) solid var(--oa-focus)` so they pick up the surface's focus color |
| `--oa-scrim` | 40% ink | 60% black | Dialog overlay |
| `--oa-elevated-border` | transparent | `#3A414B` | Border on popovers/dialogs (replaces shadows in dark) |

`--oa-warning` is 3.4:1 on light surfaces, so it is for icons and borders only; pair it with `--oa-text` for message text.

Tag colors: an 8-color categorical set, each at least 4.5:1 on `--oa-surface` and `--oa-bg` in both themes:

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Light | `#0F766E` | `#1D4ED8` | `#6D28D9` | `#A21CAF` | `#B91C1C` | `#B45309` | `#4D7C0F` | `#475569` |
| Dark | `#2DD4BF` | `#93C5FD` | `#C4B5FD` | `#F0ABFC` | `#FCA5A5` | `#FCD34D` | `#BEF264` | `#CBD5E1` |

### Focus on the canvas

Mark canvas areas with `data-surface="canvas"` (tree view, person header band, canvas demos) and surfaces floating on them with `data-surface="raised"` (`Toolbar` and `Minimap` do this themselves). The attribute swaps `--oa-focus`, so every component's focus ring keeps 3:1 against whatever it sits on. `src/design/tokens.test.ts` asserts the token pairs, and e2e checks the rendered ring on a canvas card in both themes.

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
| `PersonCard` | `person: PersonSummary`, `size` (`compact` 96x120 / `regular` 120x150), `selected`, `focusPerson`, `duplicate`, `isPrivate`, `highlighted`, `dimmed`, plus button props | Top stripe colored by sex + sex icon badge on the avatar. States read apart by shape, not just color: keyboard focus is a detached ring (4px offset, canvas focus color), focus person an attached `--oa-canvas-text` ring plus lift and bold name, selected an inset accent ring plus tint and a check badge (selected focus person shows both rings). Private/living shows a lock and "Private" and withholds name, dates and sex (neutral stripe, no sex badge). Duplicate: dashed border + link icon. Tree highlight: `highlighted` is an attached focus-canvas ring plus a tag badge; `dimmed` drops color and shadow onto a sunken fill without touching text contrast. Every state is also in the accessible name (`personCardLabel`). No portals, tooltips or per-card effects, so it stays cheap in a virtualized tree. |
| `Avatar` | `name`, `sex`, `src`, `size` (24/40/64/120), `fallback` (`silhouette`/`initials`), `decorative` | Photo is `loading="lazy" decoding="async"` with fixed width/height; falls back on error. Silhouette shows a Mars/Venus/person icon tinted by sex. |
| `LifespanText` | `birth`, `death` (`LifeDate`), `living` | `1911–1957`, `1947–Living`, `abt. 1890–1955`, `b. 1820`, `d. 1880`. Tabular numerals. Formatting in `lib/lifespan.ts`. |
| `QuickViewPopover` | `person`, `anchor` (the clicked card element, or a `QuickViewAnchor` with `getBoundingClientRect`, `focus` and `isConnected` for virtualized cards), `open`, `onOpenChange`, `birth`/`death` (`{ date, place }`), `onMakeFocus`, `onEdit` | One controlled instance per canvas, anchored to the active card through a virtual ref, rather than a popover per card. Give cards `aria-haspopup="dialog"` and `aria-expanded`. Avatar, serif name, born/died lines, Profile (link to `/person/$id`), Make focus, Edit. Actions close it; focus returns to the card. |
| `TreeToolbar` | `layout`, `onLayoutChange`, `onFind`, `onHome`, `onZoomIn`, `onZoomOut`, `onFit`, `layoutMenuOpen`/`onLayoutMenuOpenChange`, `minimapVisible`/`onToggleMinimap` (a pressed toggle, `M`) | Vertical `Toolbar` of IconButtons with tooltips and shortcuts (`L`, `F`, `H`, `+`, `-`, `0`); layout is a radio menu (family, pedigree, descendants, fan). The tree view binds the shortcuts. |
| `Minimap` | `nodes` (rects + sex), `bounds`, `viewport`, `onNavigate(center)`, `onDismiss`, `width`, `height` | Canvas overview with the viewport rectangle; click or drag to move, arrow keys pan by a quarter viewport. Nodes are drawn once into an offscreen layer per tree, size and theme, so moving the viewport on every pan frame only composites it. In the tree view it sits bottom-left, moves bottom-right when a row label or the active card is under it, and hides when both corners are taken. |
| `GenerationLabel` | `children` | Muted uppercase caption for the canvas. |
| `TimelineItem` | `year`, `age`, `title`, `date`, `place`, `sourceCount`, `variant` (`own`/`family`/`alternate`), `actions` | Renders an `<li>`; wrap in `<ol>`. Family events: sunken row + people icon + hidden "Family event" text. Alternate: indented, dotted rule, "alternate" chip. Unsourced: muted italic "No sources". |
| `RelationshipList` | `groups: { title, subtitle?, people, nested?, collapsible?, defaultCollapsed?, actions?, onAdd?, addLabel? }[]`, `headingLevel` | Labelled sections with person rows (avatar, name, lifespan) that link to `/person/$id` (each link carries `data-name`). `nested` people sit indented under `people` (a spouse's children); `collapsible` turns the title into a disclosure button showing the count. `subtitle` is a short muted qualifier (the relationship type); `actions` renders at the end of the header (a menu of edits). Titles must be unique: they name the regions. |
| `RelationshipChart` | `paths: { label, cells: { person, row, col, role, step }[] }[]` (from core `chartPath`, person first, home last) | Mini chart of how two people are related: small cards placed by generation row and path column, joined by family lines (vertical through a generation, elbow at the common ancestor, horizontal for a marriage). With several paths (pedigree collapse) a `Select` labelled "Path (N)" switches between them. `role` marks the person and home (accent border) and the common ancestor (sunken, captioned). A `null` person is a family with no recorded parents ("Unknown parents"). Cards link to `/person/$id` with names like "Horace Ashdown, 1848 to 1910"; the list reads in path order and each item says what that person is to the previous one ("father of Felix Ashdown", visually hidden). Used in a popover from the person header's "Show path". |
| `SourceItem` | `title`, `citation`, `quality` (GEDCOM QUAY 0-3), `externalUrl`, `externalLabel` | Quality chip (dashed when weak), external link opens in a new tab with `rel="noreferrer noopener"`. |
| `TagBadge` | `label`, `color` (1-8), `variant` (`badge`/`dot`) | Dot variant is a labelled image for dense spots. |
| `CommandPalette` | `open`, `onOpenChange`, `groups: { heading, items: PaletteAction[], unfiltered? }[]`, `onQueryChange`, `title` (default `Command palette`), `shouldFilter` (default true), `footer`, `loading`, `pending` | Radix dialog + cmdk. Local groups (actions) match when the query starts the label or contains a whole keyword, so a typed name never lands on an action, and they rank below `unfiltered` groups (server people search), which show as given. Items may have a `description` line, an `onAltSelect` run by Shift+Enter or Alt+Enter, `disabled` (dimmed, skipped by the keyboard; used for the previous query's results while new ones load), and `keepOpen` (runs without closing the palette or clearing the query; used by "Show all N people"). With `pending`, Enter pressed before results arrive runs on the first fresh result. The highlight moves to the first item whenever the list changes. "No results" empty state; restores focus to whatever was focused before it opened. |
| `Button` | `variant` (primary, secondary, ghost, danger), `size` (sm/md), `loading`, `iconStart`, `iconEnd` | `loading` disables and sets `aria-busy`. |
| `IconButton` | `label` (required), `icon`, `size`, `variant` (ghost/secondary/canvas), `pressed`, `shortcut`, `tooltip`, `tooltipSide` | Label is the accessible name and the tooltip. `IconButtonBase` is the same button without a tooltip, for initial-bundle code. |
| `Toolbar` | `label`, `orientation` | ARIA toolbar with roving tabindex: one Tab stop, arrows/Home/End move. |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | Radix Tabs props | Active tab: weight + underline, not color alone. |
| `Popover`, `PopoverTrigger`, `PopoverContent` (`label`), `PopoverClose`, `PopoverAnchor` | Radix Popover props | Content is a labelled dialog. |
| `Dialog` | `title`, `hideTitle`, `description`, `trigger`, `footer`, `size` (sm/md/lg), `open`, `onOpenChange`, `returnFocusFallback` | Focus trapped, initial focus on the first field (close button is last in DOM order). On close focus returns to the opener: the `trigger`, else the control that had focus when it opened (or, for a menu item, the menu's trigger), else `returnFocusFallback` (e.g. Add event after an event is deleted). `DialogClose` wraps footer buttons. |
| `Tooltip` | `content`, `shortcut`, `side`, `children` | Opens on hover and keyboard focus. Self-contained provider; `TooltipProvider` optional for groups. |
| `ToastProvider`, `useToast()` | `toast({ title, description, variant: info/error, duration, action })` | Icon + colored edge per variant. `action: { label, onClick }` adds one button (e.g. Undo after a delete); keep the same action reachable another way, such as a shortcut, since toasts time out. |
| `Input`, `Textarea` | `label`, `hint`, `error`, plus native props; `Input` also `suggestions` | Shared `Field` wiring: label, `aria-describedby` for hint and error, `aria-invalid`; error has an icon. `suggestions` adds a native `<datalist>` (any text still allowed; the field reads as a combobox), used for places in the event form. |
| `Select` | `label`, `options: { value, label, disabled? }[]`, `value`, `onValueChange`, `placeholder`, `disabled` | Radix Select. |
| `Combobox` | `label`, `options`, `value`, `onValueChange`, `placeholder`, `searchLabel`, `emptyText`, `disabled`, `onSearchChange`, `selectedLabel` | Button trigger (`role="combobox"`) opening a filterable cmdk list in a popover. With `onSearchChange` it shows server results as given (no client filtering); `selectedLabel` names a selection that is no longer in `options`. |
| `Checkbox` | `label`, `description`, `indeterminate`, native props | Native input with `accent-color`. |
| `Switch` | `label`, native props | Native checkbox with `role="switch"`; state shown by knob position. |
| `Menu`, `MenuTrigger`, `MenuContent`, `MenuItem`, `MenuRadioGroup`, `MenuRadioItem`, `MenuSeparator`, `MenuLabel` | Radix DropdownMenu props | Used by the File menu and the layout switch. An item that is unavailable but should say why stays focusable with `aria-disabled` (dimmed) and points `aria-describedby` at a `MenuLabel` with the reason, since Radix skips `disabled` items in keyboard navigation. |
| `Skeleton` | `width`, `height`, `shape` (text/rect/circle) | Decorative (`aria-hidden`); the container sets `aria-busy`. Size to the final content. |
| `EmptyState` | `icon`, `title`, `level` (1-3), `description`, `action` | `level={1}` when the empty state is the page (serif title). |
| `Panel` | `title`, `actions`, `variant` (raised/sunken), `headingLevel` | Titled panels are labelled regions. |
| `DateInput` | `label`, `value`, `onValueChange`, `hint`, `error`, input props | Keeps the text exactly as typed (it is stored as `date_text`). A live preview line under it (`aria-live`, part of the field's description) shows how core `parseDate` reads it: `abt. 1890 · about`, `bet. 1900 and 1905 · between`, an info note for numeric dates that could be read day first, or a warning that text is not a date and will be kept as text. The line is reserved so the form never shifts. |
| `ConfirmDialog` | `open`, `onOpenChange`, `title`, `description`, `confirmLabel`, `onConfirm`, `danger` | `role="alertdialog"`; Cancel has initial focus so Enter never confirms by accident; focus returns to the opener on close. Stacks above a dialog it was opened from. Use for deletes, and say whether the action can be undone. |

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

### Editing

- Edits go through `useEdit(tree)` (`src/api/edits.ts`). An optimistic update of the cached person detail is applied in the same event as the click; on error the old detail is restored and an error toast names the edit; afterwards every query of the tree is refetched.
- One user action is one undo step: dialogs that change several records (Edit person, creating and attaching a tag) send them together to `POST /batch` with a label naming the person, e.g. `Edit Ada Vale`. Cmd/Ctrl-Z and Shift-Cmd/Ctrl-Z (or Ctrl-Y) undo and redo anywhere except inside text fields, which keep their own undo; a toast names what was undone. The History panel in the top bar lists recent batches, with undone ones struck through and labelled.
- Edit dialogs mount only while open, so each opening starts from the saved values.
- If the person on screen stops existing (undoing their creation, redoing their delete), the page says so in a toast and goes back, or home when there is no previous page.

## Layout patterns

- **App shell:** skip link, 48px sticky top bar (home link, tree name, People link, Find with the Cmd/Ctrl-K hint, File menu with import/export, theme toggle), then `<main id="main">`. Cmd/Ctrl-K toggles the command palette from anywhere; other Find buttons (the tree toolbar's Find in tree) call `usePalette().open()` from `app/palette.ts`.
- **Command palette people search:** results show avatar, name, lifespan and birthplace. Enter opens the person page and Shift/Alt+Enter shows them in the tree; on `/tree/*` the two swap, so Find in tree re-focuses the tree by default.
- **People list (`/people`):** full-height page with the title, a live count and Sex / Living / Tag filters (kept in the URL), then an ARIA table (`role="table"`, `aria-rowcount`, `aria-sort` on the sorted column header) whose body is virtualized with `@tanstack/react-virtual` and loads 100-row pages from the server as they scroll into view.
- **Tree page:** full-bleed canvas, left floating toolbar, bottom-left minimap, quick view popovers anchored to cards. Cards, chevrons and the parent set switcher sit on a transformed world layer; generation labels in a left gutter (pedigree: column heads). Below 35% zoom cards and edges are painted on one canvas layer (blocks striped by sex); generation labels read relative to the focus person ("Ada's grandparents"). Details in `apps/web/src/tree/README.md`.
- **Person page** (`/person/$id`, tab in `?tab=`): header band on `--oa-canvas` marked `data-surface="canvas"` (avatar 120, serif display name, `BIRTH`/`DEATH` lines with date and place, relationship to the home person on a reserved line, tags, View in tree), tab bar (Facts, Gallery, Notes, LifeStory, Sources), then the Facts grid: Timeline 1.6fr, Sources 1fr, Relationships 1fr at `lg`; Timeline beside Sources over Relationships at `md`; one column below. Timeline rows: own events, alternates indented under the preferred fact, relatives' births and deaths shaded as family events, filterable by category. LifeStory is set in the serif face at a reading measure.
- **Gallery tiles**: a 160px preview box on `--oa-surface-sunken` above the caption. Thumbnails are shown whole with `object-fit: scale-down`: portraits and very wide photos are letterboxed rather than cropped, and an image smaller than the box keeps its own size, centered. Tiles offer the `sm` and `md` thumbnails through `srcset` (plain `sm` for images no bigger than 160px). Media without a local file show a placeholder that says where the file is: "On Ancestry", "Online, not linked" or "File missing".

- **Tool pages** (`/checker`, `/merge`, `/tags`): a single readable column up to about 1000px, serif display title with a one-line muted intro, then the work. Each row names the people involved with links to them, and every change goes through `useEdit`, so it is undoable and appears in History.
- **Highlight in the tree** (`/tree/:id?tag=`): highlighted cards get an attached ring in `--oa-focus-canvas` and a tag badge, and say so in their accessible name. The rest are dimmed with no color, no shadow and a sunken fill, never with opacity, so their text keeps full contrast (far-out cards, which have no text, do fade). Fan segments follow the same rules. A status pill at the top gives the tagged and shown counts, Next tagged person (refocuses on the next one in id order, so people out of view are reachable) and Clear highlight.

## Content style

- Dates as stored by the user, normalized for display to `D Mon YYYY` (`5 Sep 1941`), with qualifiers abbreviated (`abt.`, `bef.`, `aft.`, `bet. 1890 and 1895`).
- Places shown shortest-first on cards (`Philadelphia, PA`), full on the person page.
- Living people: "Living" instead of a death year.
