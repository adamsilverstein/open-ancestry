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

## Output

`RelationshipResult` with `name` (all names joined with "and also", or "unrelated") and
`relationships`, each with a `name`, `kind` (`self`, `blood` or `marriage`), the `paths` that give
it, and for blood the `commonAncestors`, `generations` `[up from A, down to B]` and `half`.

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
| half sibling           | half sister                     | half-sister               |

Everything else (`3rd great-grandfather`, `2nd cousin`, `stepmother`, `sister-in-law`) is the same
in both. `relationshipName({ up, down }, sex, half?, modifier?, style?)` names a shape directly.

## Algorithm

```
            C (common ancestor)
          /   \
   up 2  P     Q  down 2
        /       \
       A         B     A is B's 1st cousin: min(2, 2) - 1 = 1st, removed |2 - 2| = 0
```

1. **Blood.** Walk the ancestors of A and of B generation by generation (20 by default, cycle
   safe, each person kept once per depth and child so pedigree collapse keeps its distinct lines).
   Every common ancestor whose two lines meet only at it is one relationship. Partners reached by
   the same two lines are the couple; one alone (or lines through different families) means half.
   Several such pairs give several names ("2nd cousin and also 3rd cousin once removed") or one
   name with several paths ("double 1st cousin", or a great-grandparent reached through both
   parents).
2. **Names.** From the generations up from A (`u`) and down to B (`d`): ancestors and descendants
   (`2nd great-grandfather`), siblings, aunts and uncles (`great-grandaunt`), nieces and nephews,
   and cousins (`min(u, d) - 1`, removed `|u - d|`), in the chosen style. Words are gendered by A's sex with neutral
   fallbacks (`parent`, `sibling`, `niece or nephew`). Step, adopted and foster links on the path
   give `stepfather`, `adoptive mother`, `adopted son`, `foster daughter` unless a biological path
   exists.
3. **Marriage.** Partners are named directly (`husband`, `wife`, `partner`) and listed alongside
   any blood relationship. Otherwise a bidirectional breadth-first search over parent, child and
   partner links finds the shortest path with one or two marriages. Common shapes get their own
   words (`father-in-law`, `sister-in-law`, `stepmother`, `stepbrother`, `step-grandmother`,
   `aunt by marriage`); anything else is a possessive chain (`husband’s sister’s husband`).

Bench (`npm run bench -- relationship`): any-to-any in a 10k-person tree, p99 about 1ms against a
10ms budget.
