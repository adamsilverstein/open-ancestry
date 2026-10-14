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
```

- **Data.** One request per focus (`up`/`down` one generation past what is shown, so the next
  chevron is instant). The endpoint returns only the focus person's siblings, so the family view
  also loads each parent's neighborhood (`up=1`) for aunts and uncles. Expanding a chevron past
  the loaded slice (`moreUp`/`moreDown`) fetches that person's neighborhood. Hovering a card
  prefetches its neighborhood.
- **Layout** runs in a module worker. The main thread and the worker each keep a `GraphCache`
  of every slice, so a layout request carries only the focus and options.
- **Re-focus.** The view jumps so the new focus card sits where it was, then tweens 180ms to the
  center (instant under `prefers-reduced-motion`). Expanding or collapsing never moves the view;
  the layout keeps the focus card at (0, 0).
- **Keyboard.** One tab stop (the active card, plus its chevrons). Arrows move by relationship
  (`relations.ts`: up a parent, down a child, left/right along the row; reversing a move goes
  back), Enter re-focuses, Space opens the quick view, `+ - 0` zoom and fit, `H` home, `F` or
  Cmd/Ctrl-K find, `L` layout menu.
- **Labels.** Cards are announced as `Name, sex, lifespan, <kinship> of <focus>` where kinship
  is read back from the layout's edges (`father`, `aunt`, `son-in-law`, `2nd great-grandmother`).

## Budgets

`e2e/tree-perf.spec.ts` on the seeded 10,000-person tree (Chromium): re-focus with cached data
(fetch, worker layout, render) from the `oa-tree-refocus` performance measure, and frame times
from `requestAnimationFrame` during a scripted pan and pinch with 2,000+ laid-out cards.
