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

Tag colors: an 8-color categorical set (`--oa-tag-1` .. `--oa-tag-8`) validated for AA against `--oa-surface` in both themes.

### Typography

Self-hosted variable fonts (no runtime network requests).

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
- Motion: `--oa-duration-fast` 120ms, `-base` 180ms, easing `cubic-bezier(.2,.0,.0,1)`. All disabled under `prefers-reduced-motion`. Tree re-focus uses a 180ms transform tween, never relayout animation.
- Breakpoints: `sm` 640, `md` 960, `lg` 1280. Person page goes 3 columns at `lg`, 2 at `md`, 1 below.

## Components

| Component | Notes |
|---|---|
| `PersonCard` | Tree card. Sizes `compact` (96x120) and `regular` (120x150). Top stripe colored by sex + sex icon in avatar. Shows avatar, name (2 lines max, ellipsis), `LifespanText`. States: default, hover, focused (focus ring), selected (accent outline), focus person (raised + bold border), private/living, duplicate (pedigree collapse: dashed border + link icon). Badges: tag dots, has-sources. |
| `Avatar` | Photo (object-fit cover, lazy, decoded off main thread) or silhouette/initials fallback tinted by sex. Sizes 24/40/64/120. |
| `LifespanText` | `1911–1957`, `1947–Living`, `abt. 1890–1955`, `b. 1820`. Tabular numerals. |
| `QuickViewPopover` | Card click: avatar, name, birth/death lines, actions (Profile, Make focus, Edit). |
| `TreeToolbar` | Vertical left toolbar: layout switch, find, home, zoom in/out, fit. IconButtons with tooltips and shortcuts. |
| `Minimap` | Canvas-drawn overview with viewport rectangle; dismissible. |
| `GenerationLabel` | "Grandparents" style labels on canvas, muted text. |
| `TimelineItem` | Year column + age, title, date and place, source count, actions. Variants: own event, family event (sunken background), alternate fact (indented, "alternate" chip). |
| `RelationshipList` | Grouped person rows (avatar, name, lifespan) with section headers and add buttons. |
| `SourceItem` | Title, citation page, quality chip, external link icon for `_APID`. |
| `TagBadge` | Color dot + label; category grouping in pickers. |
| `CommandPalette` | Cmd/Ctrl-K global search (people, places, actions). |
| Primitives | `Button` (primary, secondary, ghost, danger; sm/md), `IconButton`, `Tabs`, `Dialog`, `Popover`, `Tooltip`, `Toast`, `Input`, `Textarea`, `Select`, `Combobox`, `DateInput` (live parse preview), `Checkbox`, `Switch`, `Skeleton`, `EmptyState`, `Panel`. |

## Layout patterns

- **App shell:** 48px top bar (tree name switcher, Find, command palette hint, theme toggle, import/export menu). Content fills the rest.
- **Tree page:** full-bleed canvas, left floating toolbar, bottom-left minimap, quick view popovers anchored to cards.
- **Person page:** header band on `--oa-canvas` (avatar 120, serif name, birth/death, relationship to home, tags, Edit), tab bar, then the three-column Facts grid (Timeline 1.6fr, Sources 1fr, Relationships 1fr).

## Content style

- Dates as stored by the user, normalized for display to `D Mon YYYY` (`5 Sep 1941`), with qualifiers abbreviated (`abt.`, `bef.`, `aft.`, `bet. 1890 and 1895`).
- Places shown shortest-first on cards (`Philadelphia, PA`), full on the person page.
- Living people: "Living" instead of a death year.
