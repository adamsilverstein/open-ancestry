/**
 * Vertical family view (Ancestry's "family view") and descendant chart.
 *
 * Two tidy trees share the focus row: ancestors grow up from it and
 * descendants grow down. The focus block (focus person plus spouses) is the
 * root of both, so they merge by aligning that block, then everything is
 * translated so the focus card sits at (0, 0) whatever is expanded.
 */
import { Builder, settingsFrom } from './build';
import type { Card, FamilyLink, Role, Unit } from './build';
import { indexGraph } from './graph';
import {
  boundsOf,
  DEFAULT_CARD,
  DEFAULT_GAPS,
  emptyLayout,
  generationLabel,
  nodesFrom,
  z,
} from './output';
import type { Chevrons } from './output';
import { tidyLayout } from './tidy';
import type {
  CardSize,
  GenerationLabel,
  LayoutEdge,
  LayoutGaps,
  LayoutOptions,
  Point,
  TreeGraph,
  TreeLayout,
} from './types';

const FAMILY_CHEVRONS: Chevrons = {
  up: new Set<Role>(['focus', 'spouse', 'ancestor']),
  down: new Set<Role>(['focus', 'descendant']),
  siblings: new Set<Role>(['focus', 'ancestor']),
};
const DESCENDANT_CHEVRONS: Chevrons = {
  up: new Set(),
  down: FAMILY_CHEVRONS.down,
  siblings: new Set(),
};

/** Focus person and spouses in the middle row, ancestors above, descendants below. */
export function layoutFamily(
  graph: TreeGraph,
  focusId: string,
  options: LayoutOptions = {},
): TreeLayout {
  return layoutVertical(graph, focusId, options, true);
}

/** The lower half of the family view: focus person, spouses and descendants. */
export function layoutDescendants(
  graph: TreeGraph,
  focusId: string,
  options: LayoutOptions = {},
): TreeLayout {
  return layoutVertical(graph, focusId, options, false);
}

function layoutVertical(
  graph: TreeGraph,
  focusId: string,
  options: LayoutOptions,
  withAncestors: boolean,
): TreeLayout {
  const index = indexGraph(graph);
  if (!index.person(focusId)) return emptyLayout();
  const size = { ...DEFAULT_CARD, ...options.cardSize };
  const gaps = { ...DEFAULT_GAPS, ...options.gaps };
  const s = settingsFrom(options, { ancestorsDepth: 3, descendantsDepth: 2 });
  const b = new Builder(index, s);

  const focus = b.card(focusId, 'focus', 0);
  const descRoot = b.unit([focus], 0);
  const descQueue = b.addFamilies(
    descRoot,
    b.budget(focusId, 'down', s.descendantsDepth),
    true,
    gaps.sibling,
  );

  let ancUnits: Unit[] = [];
  if (withAncestors) {
    b.addSiblings(descRoot, 'center');
    const ancRoot = b.unit(descRoot.cards, 0);
    const queue = descRoot.cards.flatMap((card, i) => {
      if (card.role !== 'focus' && card.role !== 'spouse') return [];
      const base = card === focus ? s.ancestorsDepth : 0;
      return b.addParents(ancRoot, i, b.budget(card.personId, 'up', base), gaps.couple);
    });
    ancUnits = [ancRoot, ...b.growAncestors(queue, gaps.couple, true)];
  }
  const descUnits = [descRoot, ...b.growDescendants(descQueue, gaps.sibling)];

  const metrics = { card: size.width, couple: gaps.couple, sibling: gaps.sibling };
  const step = size.width + gaps.couple;
  const rowStep = size.height + gaps.generation;
  const place = (units: Unit[], sign: number) => {
    tidyLayout(units, metrics);
    for (const u of units) {
      u.cards.forEach((card, i) => {
        card.x = u.x + i * step;
        card.y = z(sign * u.level * rowStep);
      });
    }
  };
  place(ancUnits, -1);
  place(descUnits, 1);
  const dx = focus.x;
  for (const card of b.cards) card.x -= dx;

  const nodes = nodesFrom(b, size, withAncestors ? FAMILY_CHEVRONS : DESCENDANT_CHEVRONS);
  const bounds = boundsOf(nodes);
  const generations = [...new Set(nodes.map((n) => n.generation))]
    .filter((g) => g !== 0)
    .sort((p, q) => p - q);
  const labels = generations.map((generation): GenerationLabel => ({
    generation,
    text: generationLabel(generation),
    x: bounds.minX,
    y: z(generation * rowStep + size.height / 2),
    anchor: 'right-middle',
  }));
  return {
    focusKey: focus.key,
    nodes,
    edges: verticalEdges(b.links, b.cards, size, gaps),
    labels,
    bounds,
    alternateParentFamilies: b.alternates,
  };
}

/** Index of the first value in sorted `xs` that is greater than `x` (or >= when `inclusive`). */
function search(xs: number[], x: number, inclusive: boolean): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < x || (!inclusive && xs[mid] === x)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Couple connectors, the drop from each couple to its sibling bar, the bar
 * itself and one drop per child. Partners with other cards between them (a
 * third spouse) are joined by a lane below the row instead of a straight line.
 */
function verticalEdges(
  links: FamilyLink[],
  cards: Card[],
  size: CardSize,
  gaps: LayoutGaps,
): LayoutEdge[] {
  const { width: w, height: h } = size;
  const rows = new Map<number, number[]>();
  for (const c of cards) {
    const row = rows.get(c.y);
    if (row) row.push(c.x);
    else rows.set(c.y, [c.x]);
  }
  for (const row of rows.values()) row.sort((p, q) => p - q);
  const cardsBetween = (y: number, x1: number, x2: number) => {
    const row = rows.get(y)!;
    return search(row, x2, true) - search(row, x1, false);
  };

  const edges: LayoutEdge[] = [];
  links.forEach((link, n) => {
    const { familyId } = link;
    const group = `${familyId}#${n}`;
    const parents = [...link.parents].sort((p, q) => p.x - q.x);
    let drop: Point | undefined;
    if (parents.length === 2) {
      const [l, r] = parents as [Card, Card];
      const lanes = cardsBetween(l.y, l.x, r.x);
      let points: Point[];
      if (lanes === 0) {
        const cy = l.y + h / 2;
        points = [
          [l.x + w, cy],
          [r.x, cy],
        ];
        drop = [(l.x + w + r.x) / 2, cy];
      } else {
        // Deeper lanes for couples further apart, all above the sibling bars.
        const laneY = l.y + h + ((gaps.generation / 2) * lanes) / (lanes + 1);
        const lx = l.x + w / 2;
        const rx = r.x + w / 2;
        points = [
          [lx, l.y + h],
          [lx, laneY],
          [rx, laneY],
          [rx, r.y + h],
        ];
        drop = [(lx + rx) / 2, laneY];
      }
      edges.push({ kind: 'couple', familyId, group, points, parents: [l.key, r.key] });
    } else if (parents.length === 1) {
      const p = parents[0]!;
      drop = [p.x + w / 2, p.y + h];
    }
    if (link.children.length === 0) return;

    const childY = link.children[0]!.card.y;
    const barY = childY - gaps.generation / 2;
    const xs = link.children.map((c) => c.card.x + w / 2);
    let minX = Math.min(...xs);
    let maxX = Math.max(...xs);
    // Siblings shown without their parents still share a bar, just no drop.
    if (drop) {
      edges.push({
        kind: 'parent-child',
        familyId,
        group,
        points: [drop, [drop[0], barY]],
        parents: parents.map((p) => p.key),
      });
      minX = Math.min(minX, drop[0]);
      maxX = Math.max(maxX, drop[0]);
    }
    if (minX < maxX) {
      edges.push({
        kind: 'sibling-bar',
        familyId,
        group,
        points: [
          [minX, barY],
          [maxX, barY],
        ],
      });
    }
    link.children.forEach(({ card, rel, half }, i) => {
      const edge: LayoutEdge = {
        kind: 'parent-child',
        familyId,
        group,
        points: [
          [xs[i]!, barY],
          [xs[i]!, childY],
        ],
        child: card.key,
        rel,
      };
      if (half) edge.half = true;
      edges.push(edge);
    });
  });
  return edges;
}
