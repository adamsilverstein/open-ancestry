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

`e2e/tree-perf.spec.ts` on the seeded 10,000-person tree (Chromium, 1440x900): re-focus with
cached data (fetch, worker layout, render) from the `oa-tree-refocus` performance measure with
500+ people on screen, and frame times from `requestAnimationFrame` during a scripted pan and
pinch over 2,796 laid-out cards, both at fit (2,000+ painted on screen) and just above the canvas
threshold with cards mounted. The world layer reports `data-visible-count` for these checks.
