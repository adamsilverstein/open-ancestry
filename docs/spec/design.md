# open-ancestry: Product & Architecture Spec

Status: v1 (2026-10-14)

## 1. Purpose

open-ancestry is an open source, local-first family tree application. It reproduces the core family tree experience of Ancestry.com (tree view and person detail view) on top of a local database that the user owns. The primary user flow is:

1. Export a tree from Ancestry.com (Tree Settings > Export tree, a GEDCOM 5.5.1 `.ged` file).
2. Import it into open-ancestry (optionally with a media folder from RootsMagic/FTM, or a GEDZIP).
3. Browse, search, edit, and re-export the tree, entirely offline, very fast.

### Goals

- **Lossless import of Ancestry exports.** Every GEDCOM line is either mapped to the domain model or preserved verbatim, so nothing is ever dropped and the file can be round-tripped.
- **Lightning fast.** Performance budgets (section 7) are enforced in CI from the first PR that touches each path.
- **Well-defined local data format.** A documented, versioned SQLite schema (`docs/data-model.md`) plus a JSON interchange format with a JSON Schema.
- **Modern, accessible UI** built on a documented design system (`docs/design-system.md`).
- **Private by default.** Data never leaves the machine. The server binds to loopback only.

### Non-goals (v1)

- Ancestry server features: record hints, record search, DNA matching, collaboration/sharing, comments, Memories.
- Downloading media from Ancestry servers (requires auth, may conflict with their ToS). We show remote media as placeholders keyed by Ancestry's media ids.
- Multi-user / hosted deployment.
- Mobile-native apps (the web UI must still work at phone widths).

## 2. Research summary

Observed in Ancestry (owner's account, read-only) and their help docs:

- **Family (vertical) tree view:** dark canvas, person cards (photo or silhouette, name, life years, "Living"), couples joined by a connector, generation labels ("X's grandparents"), expand/collapse chevrons, left vertical toolbar (layout switch, media, find, home, zoom in/out), minimap, "Find in tree".
- **Horizontal pedigree view, fan view, map view** as alternative layouts.
- **Quick view popover** on card click: photo, name, birth/death summary, Profile / Search / Hints / more.
- **Person page:** header (photo, serif name, birth/death, relationship to home person, tags), tabs (Facts, Hints, Gallery, LifeStory, Explore). Facts tab is three columns: **Timeline** (events with year and age, interleaved family events such as sibling births and parent deaths shown shaded, filter and add), **Sources**, **Relationships** (parents, siblings, spouses and children, add family).
- Parent-child relationship types: biological, adopted, step, foster, related, guardian, private.
- Living-person inference: no death facts and born under 100 years ago.
- MyTreeTags (research status, custom tags), list of all people, relationship to home person with path, merge duplicates, tree checker.
- Export: GEDCOM 5.5.1, UTF-8, `HEAD.SOUR` "Ancestry.com Family Trees". Custom tags include `_APID`, `_MTTAG`/`_MTCAT`, `_OID`, `_MILT`, `_PHOTO`/`_PRIM`, `_FREL`/`_MREL`, FTM-style event tags. Media binaries are not included. Xref ids may change between exports.

## 3. Architecture

```
            +---------------------------------------------------------+
 browser    |  apps/web  (Vite + React 19 SPA)                        |
 localhost  |   routes: /tree/:personId  /person/:id  /people  /import|
            |   tree renderer (virtualized DOM cards + SVG edges)     |
            |   layout worker (packages/core layout, off main thread) |
            +-----------------------------+---------------------------+
                                          | JSON over HTTP (127.0.0.1)
            +-----------------------------v---------------------------+
 node       |  apps/server (Fastify)                                  |
            |   REST API, import jobs, media + thumbnails, SPA static |
            +------+------------------+-----------------+-------------+
                   |                  |                 |
        packages/db          packages/gedcom      packages/core
        SQLite schema,       tokenizer, parser,   dates, names, living,
        migrations, repos    Ancestry adapter,    relationship calc,
        (better-sqlite3)     exporters            tree layout
                   |
        ~/OpenAncestry/<tree>.oatree/   (tree.sqlite + media/ + thumbs/)
```

### Monorepo layout (npm workspaces, TypeScript strict, ESM, Node 24 LTS)

| Package | Responsibility | Depends on |
|---|---|---|
| `packages/core` | Pure TS domain logic, no I/O: genealogical dates, name handling, living inference, relationship calculator, tree layout engines. Runs in Node and in a Web Worker. | none |
| `packages/db` | SQLite schema, versioned migrations, typed repositories, FTS search, change log / undo. | core |
| `packages/gedcom` | Streaming GEDCOM 5.5.1 + 7 tokenizer/parser, GEDCOM/JSON exporters, GEDZIP. | core |
| `packages/import` | GEDCOM/GEDZIP to domain mapper with the Ancestry adapter, import report, media linking. | core, db, gedcom |
| `apps/server` | Fastify HTTP API, import jobs, media serving, static SPA, security headers. | core, db, gedcom, import |
| `apps/web` | React SPA: design system components, tree views, person page, search, editing, import UI. | core (types, layout in worker) |
| `apps/cli` | `open-ancestry serve`, `import <file>`, `export`, `bench`. | server, db, gedcom |
| `e2e/` | Playwright tests against a real server with synthetic fixture trees. | all |
| `fixtures/` | Synthetic GEDCOM fixtures (Ancestry-style), deterministic large-tree generator. **Never real family data.** | |

### Key technical decisions

- **SQLite file per tree** (`tree.sqlite`, WAL mode) inside a `.oatree` directory with `media/` and `thumbs/`. A tree is a folder you can copy, back up, or put in git-lfs. Default library root `~/OpenAncestry`, configurable.
- **better-sqlite3** (synchronous, fastest Node SQLite binding). Prepared statements everywhere. FTS5 for search.
- **Fastify** for the API: fast, schema-validated routes (JSON Schema generated from shared TypeBox/Zod types).
- **React 19 + TanStack Router + TanStack Query.** Route-level code splitting. No runtime CSS-in-JS: CSS Modules + CSS custom property tokens.
- **Tree rendering:** layout computed in a Web Worker by `packages/core`; the renderer virtualizes, only mounting DOM cards inside the viewport (plus overscan), edges drawn as a single SVG path set per tile. Pan/zoom via CSS `transform` on a container (GPU composited). DOM cards keep the tree keyboard and screen-reader accessible and easy to e2e test.
- **API shape for the tree:** `GET /api/tree/neighborhood?focus=:id&up=4&down=3` returns a compact graph slice (people summaries + edges) so the initial tree view is one request; more generations load on expand.
- **Stable ids:** ULIDs for all records. GEDCOM xrefs are stored as `external_id` with the import batch, never used as primary keys.

## 4. Data model (summary)

Full schema with DDL lives in `docs/data-model.md` (owned by `packages/db`, kept in sync by a test that diffs the doc against the migrations). Model is Gramps-like and normalized:

- `person` (id, sex, living: inferred | true | false, privacy, primary_media_id, created/updated)
- `person_name` (person_id, type: birth/married/aka, given, surname, prefix, suffix, nickname, sort order, is_primary)
- `event` (id, type: GEDCOM tag or custom, date_text, date_sort, date_qualifier, place_id, description, value, age)
- `event_role` (event_id, person_id or family_id, role: principal/witness/..., is_preferred among alternates)
- `family` (id, partner1_id, partner2_id, relationship_type: married/partners/unknown, ordering)
- `family_child` (family_id, child_id, partner1_rel, partner2_rel: biological/adopted/step/foster/related/guardian/private/unknown, ordering)
- `place` (id, name, full_name, parent_id, latitude, longitude, type)
- `source`, `repository`, `citation` (source_id, page, quality, `apid`), `citation_link` (citation -> person/event/family/name)
- `media` (id, kind, mime, local_path or remote_url, ancestry_oid, title, date, sha256, width, height), `media_link`
- `note`, `note_link`; `tag` (name, category, color), `tag_link`
- `raw_record` (owner table+id, gedcom_tag, xref, raw text of the full original subtree) for lossless round-trip
- `unmapped_line` (owner, path, line) for anything the mapper does not understand
- `import_batch` (file name, sha256, source software/version, counts, warnings, started/finished)
- `change_log` (seq, ts, entity, entity_id, op, before_json, after_json, batch_id) for undo/redo and audit
- `meta` (schema_version, home_person_id, tree_name, settings)

### Genealogical dates

`core/dates` parses GEDCOM date grammar (exact, `ABT`, `CAL`, `EST`, `BEF`, `AFT`, `BET..AND`, `FROM..TO`, partial dates, dual years, Julian/Hebrew/French calendars passthrough) plus Ancestry quirks (`05/28/1960`, `2010-2019`, ISO `1941-09-05`). Output: `{ text, qualifier, start, end, calendar, sortKey }`. `sortKey` is an integer `YYYYMMDD` (missing parts set to the midpoint, qualifier offset) for indexed sorting. The original text is always kept.

### JSON interchange

`open-ancestry.json` (versioned, JSON Schema published in `packages/db/schema/oa-json.schema.json`): a full-fidelity dump of every table including raw records, for diffing, backup, and tooling.

## 5. Features and acceptance criteria

Each feature below becomes a GitHub issue. A PR closes the issue only when all its acceptance criteria are covered by tests (e2e first for anything user-visible).

### F1. Project foundation
- Monorepo builds with one command; `npm test`, `npm run e2e`, `npm run lint`, `npm run typecheck` all exist and pass in CI on every PR.
- Coverage (unit + e2e merged via istanbul) is reported in the CI job summary and as a PR comment; thresholds enforced (start 80% lines for packages, ratchet up).
- `.nvmrc` pins Node 24. README explains install, run, import.

### F2. Database schema and repositories
- Migrations create the schema in section 4; `schema_version` recorded; migrations are forward-only and tested from every past version.
- `docs/data-model.md` matches the DDL (test enforced).
- Repositories for person/family/event/etc. with typed inputs; all writes go through a unit of work that appends to `change_log`.
- Undo/redo of any change-log batch restores exact prior state (property tests).
- JSON export/import of a DB round-trips byte-identically (after canonical sort).

### F3. Genealogical dates and names
- Parses every date form listed in section 4 and Ancestry quirks; never throws; unparseable input yields `qualifier: 'text'` with the original preserved.
- `sortKey` orders dates correctly including qualifiers (property tests).
- Age-at-event computed with qualifiers ("about 25").
- Name formatting (display, sort, initials) and Soundex/Double Metaphone keys.

### F4. GEDCOM parsing
- Streaming tokenizer handles UTF-8 (with/without BOM), UTF-16, ANSEL fallback, CRLF/LF/CR, CONC/CONT, Ancestry's broken line splitting, leading whitespace, and lines over 255 chars.
- Parses GEDCOM 5.5.1 and 7.0 into a record tree; malformed lines produce warnings with line numbers, never a crash (fuzz tested).
- 100k-line file tokenizes + parses in under 500ms.

### F5. Import (GEDCOM to database, Ancestry adapter)
- All standard INDI/FAM/SOUR/REPO/OBJE/NOTE/SUBM records map to the domain model.
- Ancestry tags mapped: `_APID` (citation.apid), `_MTTAG`/`_MTCAT` (tags), `_OID`/`_PHOTO`/`_PRIM` (media and primary photo), `_FREL`/`_MREL`/`PEDI` (child relationship types), `_MILT` and FTM event tags (events), `MARR` on INDI deduplicated against FAM.
- Every input line is accounted for: mapped, or stored in `raw_record`/`unmapped_line`. A test asserts `mapped + preserved == total lines` for every fixture.
- Living status inferred (no death facts and birth < 100 years ago or unknown birth with living descendants rule) and overridable.
- Home person: taken from Ancestry header if present, else the first individual, user can change.
- Import report: counts per record type, warnings, unmapped tags summary; shown in UI and CLI.
- 10k-person synthetic Ancestry-style file imports in under 3s; 100k in under 30s.
- Importing a GEDZIP or a GEDCOM plus media folder links local media by relative path; missing files are reported.
- Re-import into an existing tree is a separate later feature (F15); v1 imports create a new tree.

### F6. Server and API
- `open-ancestry serve` starts on 127.0.0.1 (never 0.0.0.0 unless `--host` explicitly set), opens the browser.
- Endpoints: trees list/create/open, import (multipart upload + job progress via SSE), person (summary, detail with timeline), family, neighborhood graph, search, tags, media (original + thumbnails), export, mutations, undo/redo.
- All inputs validated by schema; errors are typed JSON.
- Security: Host header allowlist (DNS-rebinding defense), Origin check + per-session token for mutations, strict CSP, no CORS, path traversal-safe media serving, upload size limits.
- p95 latency < 20ms for person detail and neighborhood on a 10k tree (bench in CI).

### F7. Search
- FTS5 index over names (all name variants), places, and event years; phonetic matching on surnames.
- Command palette (Cmd/Ctrl-K) and "Find in tree" return results in < 50ms on 10k tree, keyboard navigable, jump to tree or person page.
- People list page: sortable by surname/given/birth/death, filter by tag, living, sex; virtualized to 100k rows.

### F8. App shell and design system
- Tokens (color, type, space, radius, elevation, motion) as CSS custom properties, light and dark themes, `prefers-reduced-motion` respected.
- Core components implemented and shown on a `/design` route (e2e screenshot tested): Button, IconButton, Toolbar, Tabs, Popover, Dialog, Toast, Input, Select, Combobox, Avatar, PersonCard, LifespanText, TagBadge, EmptyState, Skeleton, Panel.
- Axe accessibility check passes on every route in e2e.
- Initial JS < 150KB gzipped; LCP < 1s on localhost with 10k tree.

### F9. Family tree view (vertical, primary view)
- Matches the Ancestry family view: focus person and spouse(s), parents and grandparents above, children below, couple connectors, generation labels relative to the focus person, silhouettes by sex with photo when available, "Living" or life years.
- Card click opens quick view popover (photo, name, birth/death summary, Profile, Make focus, Edit). Double click or Enter re-centers on that person.
- Expand/collapse ancestors and descendants per card; lazy-loads more generations.
- Left toolbar: layout switch, find in tree, go home, zoom in, zoom out, fit; minimap with viewport rectangle, click/drag to navigate.
- Pan by drag, wheel/pinch zoom, keyboard arrows move focus between related cards (up = parent, down = child, left/right = spouse/sibling).
- Handles pedigree collapse (same person reachable twice) without errors: renders a linked duplicate card.
- Multiple spouses and multiple parent sets displayed with a switcher.
- URL reflects focus person (`/tree/:personId`) and is shareable/bookmarkable.
- 60fps pan/zoom with 2,000 cards laid out; focus change re-layout < 50ms for 500 visible people.

### F10. Pedigree, descendant, and fan views
- Horizontal pedigree (focus at left, ancestors right), descendant chart, and 6-generation fan chart from the same layout engine; switchable from the toolbar, preserving the focus person.

### F11. Person page
- Header: primary photo or silhouette, name (serif display), birth and death summary, relationship to home person ("father", "3rd great-grandfather"), tags.
- Tabs: Facts, Gallery, Notes, LifeStory, Sources (Hints/Explore omitted).
- Facts tab: three-column layout (Timeline, Sources, Relationships) collapsing to one column on narrow widths.
- Timeline: events sorted by date with year and age, interleaved family events (births of siblings and children, deaths of parents, spouse, children) visually distinct, filter by event category, alternate facts grouped under the preferred one.
- Sources column lists citations with `_APID` rendered as a link to the Ancestry record.
- Relationships column: parents, siblings (collapsible), spouses each with their children; every entry links to that person.
- LifeStory: generated narrative paragraphs from events (template based, no network).
- Loads in < 100ms from click on a 10k tree (data + render).

### F12. Editing
- Add/edit/delete person, names, events (with date parser preview), relationships (add parent/spouse/child/sibling, attach existing person, change relationship type), notes, tags.
- Every edit is undoable (Cmd/Ctrl-Z) and redoable; history panel lists recent changes.
- Optimistic UI with rollback on server error.

### F13. Relationship calculator
- Any-to-any relationship name in English ("2nd cousin once removed", "great-grandaunt", "half-brother", "step-mother", "sister-in-law") with the connecting path shown as a mini chart.
- Multiple paths reported when pedigree collapse exists.
- Table-driven tests covering at least 60 relationship cases.

### F14. Export
- Export GEDCOM 5.5.1 (Ancestry-compatible, preserving original custom tags from `raw_record`) and GEDCOM 7 / GEDZIP (with media), and JSON.
- Round-trip: import then export of every fixture produces semantically equivalent GEDCOM (normalized diff is empty).
- "Privatize living" option replaces living people's details with "Private".

### F15. Tags, people list, tree checker (stretch)
- Tag management (Ancestry MyTreeTags categories), filter tree and list by tag.
- Tree checker: possible duplicates, impossible dates (child born before parent, death before birth, parent age < 12 or > 70 at birth), people without sources.
- Merge two people with undo.
- Re-import an updated Ancestry export into an existing tree with fuzzy matching and a review screen.

## 6. Testing strategy

- **TDD:** every PR starts with failing tests derived from the issue's acceptance criteria.
- **E2E first** (Playwright, Chromium + WebKit) for every user-visible criterion, run against the real server with synthetic fixture trees. Visual snapshots for the design system page and tree views.
- **Unit** (Vitest) for core, db, gedcom; property-based tests (fast-check) for dates, parser, undo, relationship calc; fuzzing for the tokenizer.
- **Coverage:** istanbul for unit and instrumented e2e builds, merged with `nyc`; summary posted to the PR; thresholds in CI.
- **Performance:** `npm run bench` with deterministic synthetic trees (1k, 10k, 100k people). CI fails if a budget in section 7 regresses by more than 20%.
- **Fixtures:** synthetic only. `fixtures/ancestry-sample.ged` mimics every Ancestry quirk with invented people. Real exports go in `local-data/` which is gitignored.

## 7. Performance budgets

| Path | Budget (10k-person tree, M-series laptop) |
|---|---|
| Import 10k-person Ancestry GEDCOM | < 3s |
| Server cold start to first API response | < 300ms |
| Initial page load (LCP, localhost) | < 1s; initial JS < 150KB gz |
| Neighborhood API p95 | < 20ms |
| Person detail API p95 | < 20ms |
| Search query | < 50ms |
| Tree re-focus (layout + render, 500 visible) | < 50ms |
| Pan/zoom | 60fps with 2,000 laid-out cards |

## 8. Security and privacy

- Loopback-only binding by default, Host and Origin checks, mutation token, strict CSP (`default-src 'self'`), no third-party requests at runtime (fonts self-hosted).
- Uploaded GEDCOM is untrusted: size limits, no XML/zip bombs (GEDZIP extraction limits), path traversal checks on media paths, all rendering of user text is escaped (no `dangerouslySetInnerHTML`).
- Remote media URLs from Ancestry are never fetched automatically.
- `local-data/`, `*.oatree`, `*.ged` (outside `fixtures/`) gitignored; pre-commit check blocks committing `.ged` files outside fixtures.

## 9. Delivery process

1. Each feature (F1..F15) is a GitHub issue with its acceptance criteria as a checklist.
2. An implementer agent works in its own worktree (`~/repositories/worktrees/open-ancestry-<slug>`), writes failing e2e/unit tests first, implements, keeps CI green, opens a PR that closes the issue.
3. A separate reviewer agent reviews the PR (correctness, tests vs acceptance criteria, performance, security, design system adherence) and comments on GitHub.
4. The implementer addresses the review; the orchestrator merges (squash) when CI is green and the review is resolved.
5. After all v1 features merge: QA pass (exploratory e2e on large synthetic trees), adversarial code review, and security review, each filed as issues and fixed through the same loop.
