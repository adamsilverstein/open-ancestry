# Relationship calculator

Pure TypeScript, worker-safe, deterministic. Answers "what is A to B?" in English, with every
connecting path.

```ts
import { kinshipGraph, relationship } from '@open-ancestry/core';

const r = relationship(kinshipGraph(treeGraph), 'a', 'b');
r.name; // "2nd cousin and also 3rd cousin once removed"
r.relationships[0].paths[0]; // { ids: [a, ..., b], steps: [{ kind: 'parent', rel }, ...] }
```

## Input

A `KinshipGraph` accessor: `sex(id)`, `parents(id)` and `children(id)` (each edge with the
child's `rel`: biological, adopted, step, foster...), and `partners(id)` (with the family's
relationship type). `kinshipGraph(treeGraph)` builds one over a `TreeGraph`. On the server, build
the `TreeGraph` from the `family` and `family_child` rows, or use
`kinshipGraph(fromNeighborhood(getNeighborhood(store, id, { up, down })))` for a bounded slice.

TODO(server): a helper that loads the whole tree's family and family_child rows into a
`TreeGraph`, cached per tree, for "relationship to home person" on the person page.

A family with children but no recorded partners (a GEDCOM `FAM` with only `CHIL` lines) stands
in as their shared parent, with the id `family:<familyId>` (`isVirtualParent(id)`), so its
children are still siblings.

## Output

`RelationshipResult`:

- `relationships`, closest first, at most `maxRelationships` (4). Each has a `name`, `kind`
  (`self`, `blood` or `marriage`), up to `maxPaths` (8) `paths` with the total in `pathCount`, and
  for blood the `commonAncestors`, `generations` `[up from A, down to B]` and `half`. Blood paths
  carry their own `generations`.
- `name`: the names joined with "and also", ending "and N more" past the cap, or "unrelated". A
  one-line label (the person page header) should use `relationships[0].name`.
- `complete`: false when a search bound (`maxGenerations`, `maxNodes`) stopped the walk or output
  was trimmed, so "unrelated" can be told apart from "gave up".

`relationshipCalculator(graph, { cacheSize })` returns a `relationship`-like function that caches
each person's ancestor walk (bounded LRU), for many queries over one graph such as everyone
against the home person. Its intended caller is the server's home-person relationship endpoint
(see the TODO above); the person page builds a fresh graph from two ancestor slices instead.

`chartPath(path)` turns a path into grid cells (`{ id, row, col }`, row 0 the highest person) for
the mini chart; the drawing itself belongs to the person page.

## Naming styles

`style: 'ancestry'` (the default) follows Ancestry.com, which users compare against; Ancestry's
help on family relationship terms says it uses "grand" rather than "great" for a grandparent's
sibling. `style: 'formal'` keeps the textbook forms.

| Generations (up, down) | `ancestry`                      | `formal`                  |
| ---------------------- | ------------------------------- | ------------------------- |
| (1, 3)                 | granduncle / grandaunt          | great-uncle / great-aunt  |
| (1, 4), (1, 5)         | great-granduncle, 2nd great-... | same                      |
| (3, 1)                 | grandnephew / grandniece        | great-nephew / great-niece |
| (2, 3)                 | 1st cousin 1x removed           | 1st cousin once removed   |
| (2, 5)                 | 1st cousin 3x removed           | 1st cousin 3 times removed |
| uncle's wife           | wife of uncle                   | aunt by marriage          |
| marriage chains        | sister of wife of brother       | brother’s wife’s sister   |

Ancestry phrases relatives by marriage with "of" (`wife of 1st cousin`, `niece of husband`,
`husband of sister-in-law`); formal uses possessives and "by marriage". Everything else
(`3rd great-grandfather`, `2nd cousin`, `stepmother`, `sister-in-law`, `half-sister`) is the same in
both. `relationshipName({ up, down }, sex, half?, modifier?, style?)` names a shape directly.

## Algorithm

```
            C (common ancestor)
          /   \
   up 2  P     Q  down 2
        /       \
       A         B     A is B's 1st cousin: min(2, 2) - 1 = 1st, removed |2 - 2| = 0
```

1. **Blood.** Walk the ancestors of A and of B generation by generation (20 by default, cycle
   safe). An ancestor reached through the same child at the same depth keeps up to four lines, so
   a line that runs into B's can be swapped for one that does not (checked against a brute-force
   oracle on random collapsed graphs). Every common ancestor whose two lines meet only at it is
   one relationship. Partners reached by the same two lines are the couple. It is half when the
   two children below the ancestor have different recorded parents, compared by person
   (duplicate family records for one couple stay full); a child with no recorded parents, only a
   parentless family, gives nothing to compare and counts as full.
   Several such pairs give several names ("2nd cousin and also 3rd cousin once removed") or one
   name with several paths ("double 1st cousin", or a great-grandparent reached through both
   parents).
2. **Names.** From the generations up from A (`u`) and down to B (`d`): ancestors and descendants
   (`2nd great-grandfather`), siblings, aunts and uncles (`great-grandaunt`), nieces and nephews,
   and cousins (`min(u, d) - 1`, removed `|u - d|`), in the chosen style. Words are gendered by A's sex with neutral
   fallbacks (`parent`, `sibling`, `niece or nephew`). Step, adopted and foster links on the path
   give `stepfather`, `adoptive mother`, `adopted son`, `foster daughter` unless a biological path
   exists. Half relatives are hyphenated (`half-sister`, `half-uncle`) except cousins (`half first
   cousin`).
3. **Marriage.** Partners are named directly (`husband`, `wife`, `partner`) and listed alongside
   any blood relationship, as are in-laws through A's or B's own partner (`niece and also
   daughter-in-law`, `aunt and also mother-in-law`), unless they only restate a blood tie. Without a blood
   tie only the shortest marriage path is named, so someone who is two in-laws at once (a
   brother-in-law and also a co-father-in-law) gets one name. Otherwise a bidirectional breadth-first search over parent, child and
   partner links finds the shortest path with one or two marriages. Common shapes get their own
   words (`father-in-law`, `sister-in-law`, `stepmother`, `stepbrother`, `step-grandmother`,
   `step-granddaughter`). Longer paths are named from the first marriage on and extended, with
   "of" in the Ancestry style (`husband of stepmother`, `sister of wife of brother-in-law`) and
   possessives in the formal one (`stepmother’s husband`).
   Adoption reads `adopted` when A was adopted on the way and `adoptive` when B's side was, except
   between siblings, who are `adopted brother` / `adopted sister` from either side.
   When the graph has dates (`lifespan`, `union`), a parent's spouse is a step-parent, and their
   children step-siblings, only if the union overlapped the child's life; otherwise the chain is
   named as it is (`husband of mother`, `daughter of wife`). Missing dates count as overlapping.

Bench (`npm run bench -- relationship`): any-to-any in a 10k-person tree, p99 about 1ms against a
10ms budget.

## Shared kin rules

Which links make someone a parent, how two siblings relate, and how qualified words are spelled
live in `../kin` (`parentLink`, `isParent`, `siblingKind`, `lineQualifier`, `qualify`,
`parentWord`, `childWord`, `siblingWord`). The calculator, the person page and the tree card
labels all use them, so they agree: `half-sister`, `adopted brother`, `stepbrother`,
`foster sister`, `step-aunt`; `private` links count as birth, `related` and `guardian` as care
(foster wording, `guardian`/`ward` for the direct link).

## Tree card terms

`cardTerm(path, sex, style?)` names a tree card from the path the layout walked from the focus
person: steps `U` (up to a parent, with the child's `rel`), `D` (down to a child), `S` (to a
partner) and `B` (to a sibling, with its `kind` or the `shared` links and `apart` that
`siblingKind` takes), each optionally with the reached person's `sex`. It builds the same words
as the calculator from the same kin rules: `cardTerm([U('step'), B()], 'F')` is `step-aunt`,
`[U(), B('half'), D()]` is `half first cousin`, `[up(), B('full', 'M'), S()]` is `wife of uncle`.
Shapes kinship terms do not cover (down then up without a sibling step) give `undefined`.
