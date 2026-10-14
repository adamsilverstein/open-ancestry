# Tree layout engine

Pure TypeScript layout for the tree views (design.md F9, F10). No DOM and no I/O, so it runs in
a Web Worker. The same input always gives the same output.

```ts
import { layoutFamily, layoutDescendants, layoutPedigree, layoutFan, expandKey } from '@open-ancestry/core';

const layout = layoutFamily(graph, focusId, {
  ancestorsDepth: 3,
  descendantsDepth: 2,
  expanded: [expandKey(id, 'up')],
});
```

## Input: `TreeGraph`

The server builds this slice from the database (`GET /api/tree/neighborhood`). Keep it minimal:

```ts
interface TreeGraph {
  people: Record<string, TreePerson> | Map<string, TreePerson>;
  families: TreeFamily[];
}
interface TreePerson {
  id: string;
  sex: 'M' | 'F' | 'X' | 'U';
  name: string; // display only, passed through
  lifespan?: string; // display only
  living: boolean; // display only
  hasMoreParents?: boolean; // the slice stops here; expand lazy-loads
  hasMoreChildren?: boolean;
}
interface TreeFamily {
  id: string;
  partners: [string | null, string | null];
  children: { id: string; rel1?: ChildRelation; rel2?: ChildRelation }[]; // display order
}
```

Bad data is tolerated: ids missing from `people` are treated as unknown, a person partnered with
themselves loses the second slot, repeated children are dropped and cycles terminate.

## Options

| Option                   | Default    | Meaning                                                             |
| ------------------------ | ---------- | ------------------------------------------------------------------- |
| `ancestorsDepth`         | 3 (4 ped.) | Generations above the focus person.                                 |
| `descendantsDepth`       | 2          | Generations below.                                                  |
| `expandGenerations`      | 2          | Generations an expanded chevron reveals past the depth limit.       |
| `expanded`, `collapsed`  | none       | `"<id>:up"` / `"<id>:down"` keys. Collapse wins.                    |
| `selectedParentFamilies` | none       | `{ personId: familyId }` from the parent set switcher.              |
| `cardSize`               | 120 x 150  | PersonCard `regular`; use 96 x 120 for `compact`.                   |
| `gaps`                   | 24, 16, 64 | `sibling`, `couple` and `generation` (where bars and edges are drawn). |

## Output: `TreeLayout`

- `nodes`: one per card, top-left `x, y`, `width, height`, `generation` (-1 parents, 0 focus row,
  1 children), `isFocus`, `isDuplicate` + `duplicateOf`, and `canExpandUp/Down`,
  `canCollapseUp/Down` for the chevrons. **The focus card is always at (0, 0)**, so expanding or
  collapsing never moves it. `key` is the person id, or `<id>~n` for the nth duplicate.
- `edges`: polylines (`points`) of three kinds. `couple` joins partners; `parent-child` is either
  the drop from a couple (`parents`) to the sibling bar or the drop from the bar into a child
  (`child`, with its `rel` so adoptions can be dashed); `sibling-bar` is the horizontal bar.
  Edges of one drawn family share a `group`.
- `labels`: "Parents", "Grandparents", "Great-grandparents", "2nd great-grandparents",
  "Children"... with an anchor point. The family view puts them in a left gutter
  (`right-middle`); the pedigree heads each column (`bottom-left`).
- `bounds`: the cards' bounding box.
- `alternateParentFamilies`: `{ personId: { selected, families } }` for each shown person with
  more than one parent set. Biological parents are chosen first.

`layoutFan` returns `segments` instead: `startAngle`/`endAngle` in radians (screen space, 0 to
the right, clockwise, `3*PI/2` is up), `innerRadius`/`outerRadius`, and the Ahnentafel number.

## The family view

```
 gen -2   [pgf]--[pgm]          [mgf]--[mgm]        Grandparents
               |                      |
          +----+                      +----+
          |                                |
 gen -1  [dad]-----------------------------[mom]    Parents
                          |
                   +------+
                   |
 gen  0          [ME]--[spouse]                     focus at (0, 0)
                     |
            +--------+--------+                     sibling bar
            |                 |
 gen  1   [kid1]           [kid2]                   Children
```

With several spouses the focus block is `[spouse1][ME][spouse2][spouse3]`. Each couple's children
form their own group under it, ordered like the couples, and a couple with a card between them
(`ME` and `spouse3`) is joined by a lane just below the row. Children with an unknown partner hang
from the focus card itself.

## Algorithm

1. **Walk** (`build.ts`). Breadth first from the focus person: the focus block (focus plus
   spouses) and its children, then ancestors, then deeper descendants. Each person's budget is the
   remaining depth, raised by `expanded` and zeroed by `collapsed`. The first time a person is
   reached they get a primary card; any later time a duplicate card that is never walked, which
   draws pedigree collapse and keeps cyclic data finite.
2. **Pack** (`tidy.ts`). Every unit is a rigid block of cards with child groups hung from given
   cards. Bottom-up, each subtree keeps a contour (left and right extent per level). Children are
   packed left to right, each pushed just far enough to clear the accumulated contour on every
   shared level, then the block is centered over its groups. Contours are arrays indexed by
   absolute level with a lazy offset, and a merge reuses the deeper contour, so it costs only the
   shallower depth (no quadratic blow-up on long chains).
3. **Merge**. Ancestors and descendants are two trees rooted at the same focus block, packed
   separately (levels grow up and down) and aligned on that block. They never share a row, so they
   cannot overlap. Everything is translated so the focus card is at (0, 0).
4. **Edges and labels** (`family.ts`, `pedigree.ts`) are derived from the placed cards.

The pedigree is the ancestor half rotated a quarter turn (packing along y). The descendant chart
is the family view without ancestors. The fan assigns each ancestor the Ahnentafel slot of its
ring, so missing people leave gaps rather than shifting others.

## Not yet covered

- The focus person's siblings and ancestors' other children are not drawn; re-focus on a parent to
  see them.
- A block with several child groups is centered on their average, so a wide group can sit a little
  to one side of its couple.

## Tests and budgets

- `family.test.ts`, `pedigree.test.ts`: snapshots and explicit checks for a nuclear family, three
  ancestor generations, several spouses, adoption with alternate parents, cousin marriage and
  half siblings.
- `properties.test.ts`: fast-check over random, often invalid graphs (cycles, self-parents,
  dangling ids): no overlapping cards, parents above children, edge endpoints on their cards,
  deterministic output, termination with unlimited depth.
- `bench/suites/layout.bench.ts`: 500 visible people < 20ms, 5,000 < 150ms.
