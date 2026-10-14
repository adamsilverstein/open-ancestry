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
  hasMoreSiblings?: boolean;
  birthSortKey?: number; // orders siblings; undated ones keep family order
}
interface TreeFamily {
  id: string;
  partners: [string | null, string | null];
  partnerOrder?: [number, number]; // position among each partner's families
  relationship?: 'married' | 'civil_union' | 'partners' | 'unknown'; // copied to couple edges
  children: {
    id: string;
    rel1?: ChildRelation;
    rel2?: ChildRelation;
    preferred?: boolean; // the child's preferred parent set
    order?: number; // position among the child's parent families
  }[]; // display order
}
```

`fromNeighborhood(result)` builds this from the db `getNeighborhood` result: names and
`LifespanText`-style lifespans, `moreUp`/`moreDown` as the `hasMore*` hints, children by
`sortOrder`, `isPreferred`, `childOrder`, `partner1Order`/`partner2Order` and the relationship type.
Its input type is declared structurally in core (core cannot import db) and the db type fits it.

Bad data is tolerated: ids missing from `people` are treated as unknown, a person partnered with
themselves loses the second slot, repeated children are dropped and cycles terminate.

## Options

| Option                   | Default    | Meaning                                                             |
| ------------------------ | ---------- | ------------------------------------------------------------------- |
| `ancestorsDepth`         | 3 (4 ped.) | Generations above the focus person.                                 |
| `descendantsDepth`       | 2          | Generations below.                                                  |
| `expandGenerations`      | 2          | Generations an expanded chevron reveals past the depth limit.       |
| `siblingsDepth`          | 2          | Generations whose siblings show: 0 none, 1 focus, 2 also aunts/uncles. |
| `expanded`, `collapsed`  | none       | `"<id>:up"`, `"<id>:down"`, `"<id>:siblings"` keys. Collapse wins.  |
| `selectedParentFamilies` | none       | `{ personId: familyId }` from the parent set switcher.              |
| `cardSize`               | 120 x 150  | PersonCard `regular`; use 96 x 120 for `compact`.                   |
| `gaps`                   | 24, 16, 64 | `sibling`, `couple` and `generation` (where bars and edges are drawn). |

## Output: `TreeLayout`

- `nodes`: one per card, top-left `x, y`, `width, height`, `generation` (-1 parents, 0 focus row,
  1 children), `isFocus`, `isDuplicate` + `duplicateOf`, and `canExpandUp/Down`,
  `canCollapseUp/Down` (down also on siblings, aunts and uncles),
  `canExpandSiblings`/`canCollapseSiblings` (on direct-line people) for the chevrons, and
  `isHalfSibling`. **The focus card is always at (0, 0)**, so expanding or
  collapsing never moves it. `key` is the person id, or `<id>~n` for the nth duplicate.
- `edges`: polylines (`points`) of three kinds. `couple` joins partners; `parent-child` is either
  the drop from a couple (`parents`) to the sibling bar or the drop from the bar into a child
  (`child`, with its `rel` so adoptions can be dashed; half siblings add `half` and
  `sharedParentId`, and carry their own family's `familyId`); `sibling-bar` is the horizontal bar.
  Edges of one drawn family share a `group`.
- `labels`: "Parents", "Grandparents", "Great-grandparents", "2nd great-grandparents",
  "Children"... with an anchor point. The family view puts them in a left gutter
  (`right-middle`); the pedigree heads each column (`bottom-left`).
- `bounds`: the cards' bounding box.
- `alternateParentFamilies`: `{ personId: { selected, families } }` for each shown person with
  more than one parent set. The switcher's choice wins, then the `preferred` set, then the most
  biological one.

`layoutFan` returns `segments` instead: `startAngle`/`endAngle` in radians (screen space, 0 to
the right, clockwise, `3*PI/2` is up), `innerRadius`/`outerRadius`, and the Ahnentafel number.

## The family view

```
 gen -2          [gpa]--[gma]            [mgpa]--[mgma]          Grandparents
                       |                       |
               +-------+------+         +------+-------+
               |              |         |              |
 gen -1  [uncle1]--[aunt]   [dad]-----[mom]   [uncle2]--[wife]   Parents
                                   |
           +-----------+-----------+-----------+
           |           |                       |
 gen  0  [bro]--[wife] [ME]--[spouse]        [sis]               focus at (0, 0)
                           |
                     +-----+-----+                               sibling bar
                     |           |
 gen  1            [kid1]     [kid2]                             Children
```

Full siblings of a direct-line person, each with their spouses, share that person's sibling bar.
A father's siblings go on his left and a mother's (or any lone mother's) on her right, so the
parents stay side by side; the focus person's siblings sit in birth order around the focus
couple. Half siblings sit outside the full ones on their shared parent's side, grouped by family,
and hang from that parent alone under their own family id (`half`, `sharedParentId`). Next to a
spouse (a father's or mother's run) half siblings through the far parent are left out, as their
line would have to cross the parents'. Siblings show without their parents too, joined by one
bar with no drop. Each direct-line person has a `<id>:siblings` chevron.

Siblings, aunts and uncles have `<id>:down` chevrons. The focus person's siblings reveal nieces
and nephews (and further, like any descendant) in the children rows. The parents' siblings reveal
cousins in the focus row, kept on the outer side of their parent:

```
 gen -1  [aunt]--[husband]  [dad]--[mom]  [uncle]
               |                |            |
          +----+----+     +-----+-----+      |
          |         |     |           |      |
 gen  0 [cousin] [cousin] [bro]  [ME]--[sp] [cousin]
```

Cousins stop there (no chevrons of their own), great-aunts and the spouse's aunts get no `down`
chevron, and when a spouse's parents are shown there are no cousins on that side: in those cases
the lines could not be drawn without crossing the direct line.

With several spouses the focus block is `[spouse1][ME][spouse2][spouse3]`, in each partner's
family order. Each family's children form their own group with their own sibling bar spanning
only them:

```
            +-----------------------+              lane above the row (non-adjacent couple)
            |                       |
 [sp1]--[ME]--[sp2]              [sp3]
       |     |    |                 |
       |     |    +-----+           +------+       connectors jog on their own levels
  +----+     |          |                  |
  |          |          |              +---+---+
 [a1] [a2] [u1]       [b1]            [c1]   [c2]
```

Children hang from the couple's midpoint when the partners are side by side, from the partner's
card when they are not (`sp3`) and from the person's card when the partner is unknown (`u1`). A
connector whose children are off to one side jogs sideways on its own level: families whose
children lie to the right stack with the rightmost highest, those to the left with the leftmost
highest, so no two families' lines cross or overlap (checked by a property test). Families of
the same couple share its trunk. Lanes to further spouses nest above nearer ones, evenly spaced at least 8px apart with a margin
from the card tops and from the sibling bar above; when a block has too many spouses for the
default `generation` gap, every row moves apart to make room. Sideways jogs under 4px are drawn as
straight drops.

Only one of the focus person's spouses shows parents at a time, and only an outermost one (a lane
runs over the middle spouses); the focus person's siblings then move to the other side so the
two parent families' lines stay apart.

## Algorithm

1. **Walk** (`build.ts`). Breadth first from the focus person: the focus block (focus plus
   spouses), its children, the focus person's siblings and expanded nieces and nephews, then
   ancestors (each with their siblings and expanded cousins), then deeper descendants. Each person's budget is the
   remaining depth, raised by `expanded` and zeroed by `collapsed`. The first time a person is
   reached they get a primary card; any later time a duplicate card that is never walked, which
   draws pedigree collapse and keeps cyclic data finite.
2. **Pack** (`tidy.ts`). Every unit is a rigid block of cards with child groups hung from given
   cards. Bottom-up, each subtree keeps a contour (left and right extent per level). Children are
   packed left to right, each pushed just far enough to clear the accumulated contour on every
   shared level, then the block is centered over its groups. A sibling run is part of its
   person's block, so grandparents center over the full siblings. Cousins are `downGroups` of
   their parent's block, growing back towards the root; when a child subtree reaches the block's
   own level that way, the block is packed in line between the children on its left and right. Contours are arrays indexed by
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

- Cousins' children, great-aunts' children and a spouse's cousins are not drawn; re-focus to see
  them.
- A block with several child groups is centered on their average, so a group can sit to one side
  of its couple; its connector jogs over to it.
- Only one spouse of the focus person shows parents at a time.

## Tests and budgets

- `family.test.ts`, `pedigree.test.ts`: snapshots and explicit checks for a nuclear family, three
  ancestor generations, several spouses, adoption with alternate parents, cousin marriage, half
  siblings, and siblings/aunts/uncles with `siblingsDepth` and sibling chevrons.
- `properties.test.ts`: fast-check over random, often invalid graphs (cycles, self-parents,
  dangling ids): no overlapping cards, parents above children, edge endpoints on their cards,
  deterministic output, termination with unlimited depth.
- `bench/suites/layout.bench.ts`: 500 visible people < 20ms, 5,000 < 150ms (with and without
  siblings at every generation).
