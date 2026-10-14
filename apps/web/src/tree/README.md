# Tree view

`/tree/:personId?tree=&layout=&up=&down=` (design.md F9, F10). `personId` may be `home`;
`tree` defaults to the first tree in the library; `layout` is `family` (default), `pedigree`,
`descendants` or `fan`; `up`/`down` override the generations shown (0-10).

```
URL focus ──> TreeView ──fetchQuery──> GET /api/trees/:tree/neighborhood   (TanStack Query cache)
                 │                         │
                 │ merge slice             │ slice
                 v                         v
            GraphCache (main)  ──post──> layout.worker.ts: GraphCache + core layout*
                 │ summaries               │ TreeLayout / FanLayout
                 v                         v
            TreeCanvas <────────────── setResult (latest request wins)
              transform in a ref, written to the world layer's style (no React render per frame)
              GridIndex over cards and edges: mount only the 512px cells around the viewport
              below 35% zoom: paint every card and edge on one canvas layer instead
```

- **Data.** One request per focus (`up`/`down` one generation past what is shown, so the next
  chevron is instant). The endpoint walks straight up and down, so the family view also asks each
  grandparent for `down=3` (aunts, uncles, nephews, nieces, cousins). If one of those fails the
  rest still shows, with a Retry notice. Expanding a chevron past
  the loaded slice (`moreUp`/`moreDown`) fetches that person's neighborhood. Hovering a card
  prefetches its neighborhood.
- **Layout** runs in a module worker. The main thread and the worker each keep a `GraphCache`
  of every slice, so a layout request carries only the focus and options. The worker also labels
  every card's kinship in one walk. A layout error or a crashed worker shows "Could not load the
  tree" with Try again; the next worker is seeded from the cache's snapshot.
- **Level of detail.** At 35% zoom and above cards are mounted DOM (virtualized by cell). Below it
  card text is unreadable, so cards and edges are painted on one canvas each frame and nothing
  mounts while panning; only the keyboard's active card stays in the DOM, and clicking a painted
  card zooms in on it.
- **Framing.** The first view centers the focus card across and frames grandparents to children
  down the screen (zooming out to fit them).
- **Pointer.** Drag pans. A mouse wheel or pinch (ctrl + wheel, Safari gestures) zooms around the
  pointer; a trackpad's two-finger scroll and Shift + wheel pan (`wheelKind` in `viewport.ts`).
- **Re-focus.** The view jumps so the new focus card sits where it was, then tweens 180ms to the
  center (instant under `prefers-reduced-motion`). Expanding or collapsing never moves the view;
  the layout keeps the focus card at (0, 0).
- **Keyboard.** One tab stop (the active card, plus its chevrons). Arrows move by relationship
  (`relations.ts`: up a parent, down a child, left/right along the row; reversing a move goes
  back), Enter re-focuses, Space opens the quick view, `+ - 0` zoom and fit, `H` home, `F` (or the
  app's Cmd/Ctrl-K) opens the palette, where Enter re-focuses the tree, `L` layout menu, `M` minimap. Shortcuts act only while focus is in the tree
  (canvas, toolbar, minimap), per WCAG 2.1.4.
- **Labels.** Generation labels are relative to the focus person ("Ada's grandparents"). Cards are announced as `Name, sex, lifespan, <kinship> of <focus>` where kinship
  is read back from the layout's edges (`father`, `aunt`, `son-in-law`, `2nd great-grandmother`).

## Budgets

`e2e/tree-perf.spec.ts` (`npm run e2e:perf`, Chromium, 1440x900) checks design.md section 7 on
seeded synthetic trees of 10,000 and 100,000 people. The 100k tree (only with `OA_PERF_100K=1`,
which the script sets) uses another seed and its densest view, so its checks lay out more cards
than the 10k ones, and they assert that.

| Measure | Budget |
| --- | --- |
| First paint: home person's family view, navigation to first rendered layout, median of 5 cold loads | < 1s |
| Re-focus with cached data, key press to painted frame, median of 30 (p95 reported): at fit (500+ painted) and at 35-45% zoom (cards mounted) | < 50ms |
| Pan and pinch with 2,000+ laid out, at fit (all painted) and at 35-45% (cards mounted) | median >= 58fps, < 5% of frames over 33ms (long tasks and the longest frame reported) |
| JS heap after GC, each round of re-focuses and pans after the first | < 2MB growth |

Time budgets (and the allowed share of frames over 33ms) scale by `OA_BENCH_FACTOR` (CI: 2.5); the fps and memory budgets do not. The spec only runs with `OA_PERF=1`, which `npm run e2e:perf` and the CI `perf` job set. Results go to
`perf-results/tree-view.md`, which CI's `perf` job adds to its summary. The app marks
`oa-tree-first-paint` once and `oa-tree-ready` (replaced each time) when a layout's frame has
painted, and measures `oa-tree-refocus` from the re-focus action to that mark, keeping at most
100 of them; the world layer reports `data-visible-count`.
