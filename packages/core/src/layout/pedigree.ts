/**
 * Horizontal pedigree: the focus person at the left, each generation of
 * ancestors one column further right, fathers above mothers. It is the
 * ancestor half of the family view rotated a quarter turn, so the same tidy
 * packing runs along the y axis.
 */
import { Builder, settingsFrom } from './build';
import type { Role } from './build';
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
import { tidyLayout } from './tidy';
import type { LayoutEdge, LayoutOptions, TreeGraph, TreeLayout } from './types';

const CHEVRONS = {
  up: new Set<Role>(['focus', 'ancestor']),
  down: new Set<Role>(),
  siblings: new Set<Role>(),
};

export function layoutPedigree(
  graph: TreeGraph,
  focusId: string,
  options: LayoutOptions = {},
): TreeLayout {
  const index = indexGraph(graph);
  if (!index.person(focusId)) return emptyLayout();
  const size = { ...DEFAULT_CARD, ...options.cardSize };
  const gaps = { ...DEFAULT_GAPS, ...options.gaps };
  const s = settingsFrom(options, { ancestorsDepth: 4, descendantsDepth: 0 });
  const b = new Builder(index, s);

  const focus = b.card(focusId, 'focus', 0);
  const root = b.unit([focus], 0);
  const queue = b.addParents(root, 0, b.budget(focusId, 'up', s.ancestorsDepth), gaps.couple);
  const units = [root, ...b.growAncestors(queue, gaps.couple)];
  tidyLayout(units, { card: size.height, couple: gaps.couple, sibling: gaps.sibling });

  const column = size.width + gaps.generation;
  for (const u of units) {
    const card = u.cards[0]!;
    card.x = u.level * column;
    card.y = z(u.x);
  }

  const nodes = nodesFrom(b, size, CHEVRONS);
  const bounds = boundsOf(nodes);
  const generations = [...new Set(nodes.map((n) => n.generation))]
    .filter((g) => g !== 0)
    .sort((p, q) => p - q);

  const edges: LayoutEdge[] = [];
  b.links.forEach((link, n) => {
    const child = link.children[0]!;
    const cy = child.card.y + size.height / 2;
    const childRight = child.card.x + size.width;
    const midX = childRight + gaps.generation / 2;
    for (const parent of link.parents) {
      const py = parent.y + size.height / 2;
      edges.push({
        kind: 'parent-child',
        familyId: link.familyId,
        group: `${link.familyId}#${n}`,
        points: [
          [childRight, cy],
          [midX, cy],
          [midX, py],
          [parent.x, py],
        ],
        parents: [parent.key],
        child: child.card.key,
        rel: child.rel,
      });
    }
  });

  return {
    focusKey: focus.key,
    nodes,
    edges,
    labels: generations.map((generation) => ({
      generation,
      text: generationLabel(generation),
      x: -generation * column,
      y: bounds.minY,
      anchor: 'bottom-left',
    })),
    bounds,
    alternateParentFamilies: b.alternates,
  };
}
