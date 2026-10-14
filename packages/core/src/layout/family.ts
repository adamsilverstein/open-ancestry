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
    // A spouse whose parents are shown must not sit inside the focus person's
    // sibling run, or the two families' lines would cross: move the siblings
    // to the other side when only one side has such spouses.
    // Only one spouse at a time shows parents, and only an outermost one (a
    // couple lane to a third spouse runs over the second). The focus person's
    // siblings then go on the far side, so no family's lines cross another's.
    const last = descRoot.cards.length - 1;
    let shown: number | undefined;
    for (const [i, card] of descRoot.cards.entries()) {
      if (card.role !== 'spouse') continue;
      const outer = i === 0 || i === last;
      if (outer && shown === undefined && b.budget(card.personId, 'up', 0) > 0) shown = i;
      else card.upBlocked = !outer || shown !== undefined;
    }
    const side =
      shown === undefined || !index.parentFamilies(descRoot.cards[shown]!.personId).length
        ? 'center'
        : shown < descRoot.anchor
          ? 'right'
          : 'left';
    b.addSiblings(descRoot, side);
    const ancRoot = b.unit(descRoot.cards, 0);
    const queue = descRoot.cards.flatMap((card, i) => {
      if ((card.role !== 'focus' && card.role !== 'spouse') || card.upBlocked) return [];
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
 * Couple connectors, the connector from each couple down to its own sibling
 * bar, the bar (spanning just that family's children) and one drop per child.
 *
 * Partners with cards between them (a third spouse) are joined by a lane in
 * the gap above the row, from just right of one card's centre to just left
 * of the other's; lanes nest, so further partners ride higher and never cross. That family's children
 * hang from the partner's own card instead of a midpoint.
 *
 * When a family's drop point is outside its children's span, the connector
 * jogs sideways on its own level between the row and the bars. Within a
 * block, families whose children lie to the right are stacked with the
 * rightmost highest, those to the left with the leftmost highest, which
 * keeps every connector clear of every other family's lines. Families of the
 * same couple share the trunk down from that couple.
 */
function verticalEdges(
  links: FamilyLink[],
  cards: Card[],
  size: CardSize,
  gaps: LayoutGaps,
): LayoutEdge[] {
  const { width: w, height: h } = size;
  const half = gaps.generation / 2;
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

  interface Drop {
    link: FamilyLink;
    group: string;
    start: Point;
    parents: Card[];
    lo: number;
    hi: number;
    xs: number[];
  }
  const edges: LayoutEdge[] = [];
  const blocks = new Map<number, Drop[]>();

  const childEdges = (link: FamilyLink, group: string, xs: number[], barY: number) => {
    const { familyId } = link;
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    if (lo < hi) {
      edges.push({
        kind: 'sibling-bar',
        familyId,
        group,
        points: [
          [lo, barY],
          [hi, barY],
        ],
      });
    }
    link.children.forEach(({ card, rel, half: isHalf }, i) => {
      const edge: LayoutEdge = {
        kind: 'parent-child',
        familyId,
        group,
        points: [
          [xs[i]!, barY],
          [xs[i]!, card.y],
        ],
        child: card.key,
        rel,
      };
      if (isHalf) edge.half = true;
      edges.push(edge);
    });
  };

  links.forEach((link, n) => {
    const { familyId } = link;
    const group = `${familyId}#${n}`;
    const parents = [...link.parents].sort((p, q) => p.x - q.x);
    let start: Point | undefined;
    if (parents.length === 2) {
      const [l, r] = parents as [Card, Card];
      const between = cardsBetween(l.y, l.x, r.x);
      let points: Point[];
      if (between === 0) {
        const cy = l.y + h / 2;
        points = [
          [l.x + w, cy],
          [r.x, cy],
        ];
        start = [(l.x + w + r.x) / 2, cy];
      } else {
        const laneY = l.y - (half * between) / (between + 1);
        const sx = l.x + w / 2 + w / 2 / (between + 1);
        // Both ends sit off-centre so drops into the cards' tops stay clear.
        const rx = r.x + w / 2 - w / 2 / (between + 1);
        points = [
          [sx, l.y],
          [sx, laneY],
          [rx, laneY],
          [rx, r.y],
        ];
        const partner = link.parents[1]!;
        start = [partner.x + w / 2, partner.y + h];
      }
      const edge: LayoutEdge = {
        kind: 'couple',
        familyId,
        group,
        points,
        parents: [l.key, r.key],
      };
      if (link.relationship) edge.relationship = link.relationship;
      edges.push(edge);
    } else if (parents.length === 1) {
      const p = parents[0]!;
      start = [p.x + w / 2, p.y + h];
    }
    if (link.children.length === 0) return;
    const xs = link.children.map((c) => c.card.x + w / 2);
    if (!start) {
      // Siblings shown without their parents still share a bar, just no drop.
      childEdges(link, group, xs, link.children[0]!.card.y - half);
      return;
    }
    const drop = { link, group, start, parents, lo: Math.min(...xs), hi: Math.max(...xs), xs };
    const list = blocks.get(link.block);
    if (list) list.push(drop);
    else blocks.set(link.block, [drop]);
  });

  for (const drops of blocks.values()) {
    // Ties (one couple with several families) nest by where their children are.
    const order = (a: Drop, b: Drop) => a.start[0] - b.start[0] || a.lo - b.lo;
    const right = drops.filter((d) => d.start[0] < d.lo).sort(order);
    const left = drops.filter((d) => d.start[0] > d.hi).sort(order);
    const levels = new Map<Drop, number>();
    right.forEach((d, i) => levels.set(d, right.length - i));
    left.forEach((d, i) => levels.set(d, i + 1));
    const steps = Math.max(right.length, left.length) + 1;
    for (const d of drops) {
      const top = d.parents[0]!.y + h;
      const barY = d.link.children[0]!.card.y - half;
      const x = d.start[0];
      const level = levels.get(d);
      let points: Point[] = [d.start, [x, barY]];
      if (level !== undefined) {
        const y = top + ((barY - top) * level) / steps;
        const target = (d.lo + d.hi) / 2;
        points = [d.start, [x, y], [target, y], [target, barY]];
      }
      edges.push({
        kind: 'parent-child',
        familyId: d.link.familyId,
        group: d.group,
        points,
        parents: d.parents.map((p) => p.key),
      });
      childEdges(d.link, d.group, d.xs, barY);
    }
  }
  return edges;
}
