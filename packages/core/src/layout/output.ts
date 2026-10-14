/** Helpers that turn placed cards into the public `TreeLayout` shape. */
import type { Builder, Card, Role } from './build';
import { chooseParentFamily } from './graph';
import type { Bounds, CardSize, LayoutGaps, LayoutNode, TreeLayout } from './types';

export const DEFAULT_CARD: CardSize = { width: 120, height: 150 };
export const DEFAULT_GAPS: LayoutGaps = { sibling: 24, couple: 16, generation: 64 };

/** Turns -0 into 0 so layouts compare and serialize cleanly. */
export const z = (n: number) => n + 0;

const ordinal = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
};

/** "Parents", "Grandparents", "Great-grandparents", "2nd great-grandparents"; same for children. */
export function generationLabel(generation: number): string {
  const n = Math.abs(generation);
  if (n === 0) return '';
  const up = generation < 0;
  if (n === 1) return up ? 'Parents' : 'Children';
  const grand = up ? 'grandparents' : 'grandchildren';
  if (n === 2) return up ? 'Grandparents' : 'Grandchildren';
  if (n === 3) return `Great-${grand}`;
  return `${ordinal(n - 2)} great-${grand}`;
}

export function boundsOf(rects: { x: number; y: number; width: number; height: number }[]): Bounds {
  if (rects.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function emptyLayout(): TreeLayout {
  return {
    focusKey: null,
    nodes: [],
    edges: [],
    labels: [],
    bounds: boundsOf([]),
    alternateParentFamilies: {},
  };
}

/** Which roles get up and down chevrons in a given view. */
export interface Chevrons {
  up: ReadonlySet<Role>;
  down: ReadonlySet<Role>;
  siblings: ReadonlySet<Role>;
}

export function nodesFrom(b: Builder, size: CardSize, chevrons: Chevrons): LayoutNode[] {
  const { index } = b;
  return b.cards.map((card: Card) => {
    const person = index.person(card.personId)!;
    const dup = card.dupOf !== undefined;
    const up = chevrons.up.has(card.role) && !dup && card.upBlocked !== true;
    const down = chevrons.down.has(card.role) && !dup;
    const sibs = chevrons.siblings.has(card.role) && !dup;
    const hasSiblings =
      sibs && (b.siblingCandidates(card.personId).length > 1 || person.hasMoreSiblings === true);
    const families = index.partnerFamilies(card.personId);
    // The focus person's spouses are always shown, so only children are left to reveal.
    const hasDown =
      (card.role === 'focus'
        ? families.some((f) => index.children(f).length > 0)
        : families.length > 0) || person.hasMoreChildren === true;
    const hasUp =
      chooseParentFamily(index, card.personId, b.s.selected) !== undefined ||
      person.hasMoreParents === true;
    const node: LayoutNode = {
      key: card.key,
      personId: card.personId,
      x: z(card.x),
      y: z(card.y),
      width: size.width,
      height: size.height,
      generation: card.generation,
      isFocus: card.role === 'focus',
      isDuplicate: dup,
      canExpandUp: up && hasUp && !card.parentsShown,
      canExpandDown: down && hasDown && !card.childrenShown,
      canCollapseUp: up && card.parentsShown,
      canCollapseDown: down && card.childrenShown,
      canExpandSiblings: hasSiblings && !card.siblingsShown,
      canCollapseSiblings: sibs && card.siblingsShown,
      isHalfSibling: card.half === true,
    };
    if (dup) node.duplicateOf = card.dupOf;
    return node;
  });
}
