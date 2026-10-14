/**
 * Tidy tree packing along one axis ("breadth"), shared by every vertical and
 * horizontal layout. Each unit is a rigid block of cards on one level (a
 * person with their spouses and siblings, or a single ancestor). Its child
 * units are grouped by the card(s) they hang from: a couple's children, or
 * one person's parents in an ancestor tree. `groups` grow away from the root
 * (level + 1); `downGroups` grow back towards it (level - 1), for an aunt's
 * children (cousins) inside an ancestor tree.
 *
 * Bottom-up, every subtree keeps a contour: its leftmost and rightmost extent
 * per level. Child subtrees are packed left to right, each pushed just far
 * enough that its left contour clears the accumulated right contour on every
 * shared level. The block is then centered over its groups. `downGroups`
 * (leaves only) stay out of the contours: after placement each block's down
 * groups slide outward, as one piece, until they clear their row, so cousins
 * never push their parents' family apart.
 *
 * Contours are arrays indexed by absolute level with a lazy offset, and a
 * merge reuses the larger contour, so it costs the smaller one's depth only.
 */

export interface TidyGroup {
  /** Indexes of the block cards these children hang from. */
  anchors: number[];
  /** Never empty. */
  children: TidyUnit[];
  /** Gap between adjacent children of this group on their own level. */
  rootGap: number;
}

export interface TidyUnit {
  /** Number of cards in the block. */
  size: number;
  /** Index of the card a parent group connects to. */
  anchor: number;
  /** Never negative. */
  level: number;
  groups: TidyGroup[];
  downGroups?: TidyGroup[];
  /** Keeps `downGroups` left or right (the default) of the anchor card, and slides them that way. */
  reserve?: 'left' | 'right';
  /** Output: breadth position of the block's first card. */
  x: number;
  /** Internal: offset from the parent block. */
  rel: number;
  contour?: Contour;
}

export interface TidyMetrics {
  /** Card size along the breadth axis. */
  card: number;
  couple: number;
  sibling: number;
}

interface Contour {
  /** Stored values are relative to `off`. */
  off: number;
  l: number[];
  r: number[];
  lo: number;
  hi: number;
}

function single(level: number, width: number): Contour {
  const l: number[] = [];
  const r: number[] = [];
  l[level] = 0;
  r[level] = width;
  return { off: 0, l, r, lo: level, hi: level };
}

/** Smallest shift for `b` so it clears `a` on every shared level. */
function separation(a: Contour, b: Contour, gapAt: (level: number) => number): number {
  let shift = -Infinity;
  const top = Math.min(a.hi, b.hi);
  for (let lv = Math.max(a.lo, b.lo); lv <= top; lv++) {
    // Contours cover every level between lo and hi.
    const need = a.off + a.r[lv]! + gapAt(lv) - b.off - b.l[lv]!;
    if (need > shift) shift = need;
  }
  return shift;
}

/** Merges `b`, shifted by `shift`, into `a`'s frame. Reuses the larger contour's arrays. */
function merge(a: Contour, b: Contour, shift: number): Contour {
  b.off += shift;
  let base = a;
  let other = b;
  if (b.hi - b.lo > a.hi - a.lo) {
    base = b;
    other = a;
  }
  for (let lv = other.lo; lv <= other.hi; lv++) {
    const left = other.off + other.l[lv]!;
    const right = other.off + other.r[lv]!;
    const bl = lv >= base.lo && lv <= base.hi ? base.l[lv] : undefined;
    if (bl === undefined) {
      base.l[lv] = left - base.off;
      base.r[lv] = right - base.off;
    } else {
      base.l[lv] = Math.min(base.off + bl, left) - base.off;
      base.r[lv] = Math.max(base.off + base.r[lv]!, right) - base.off;
    }
  }
  base.lo = Math.min(base.lo, other.lo);
  base.hi = Math.max(base.hi, other.hi);
  return base;
}

interface Item {
  unit: TidyUnit;
  contour: Contour;
  /** Gap on the children's own level to the previous item. */
  rootGap: number;
}

/** Lays out `units`, which must list every parent before its children (units[0] is the root). */
export function tidyLayout(units: readonly TidyUnit[], m: TidyMetrics): void {
  const step = m.card + m.couple;
  const cardCenter = (index: number) => index * step + m.card / 2;

  /** The children of `groups` in order, each with the gap to its predecessor. */
  const itemsOf = (groups: TidyGroup[]): Item[] =>
    groups.flatMap((group) =>
      group.children.map((unit, j) => {
        const contour = unit.contour!;
        unit.contour = undefined;
        return { unit, contour, rootGap: j > 0 ? group.rootGap : m.sibling };
      }),
    );

  /** Packs items left to right; returns their positions and the merged contour. */
  const pack = (items: Item[], rootLevel: number) => {
    let acc: Contour | undefined;
    const pos: number[] = [];
    for (const item of items) {
      const c = item.contour;
      if (!acc) {
        pos.push(0);
        acc = c;
        continue;
      }
      const gapAt = (lv: number) => (lv === rootLevel ? item.rootGap : m.sibling);
      const p = separation(acc, c, gapAt);
      pos.push(p);
      acc = merge(acc, c, p);
    }
    return { pos, acc: acc! };
  };

  /** Where the block goes so its anchors sit centered over their groups. */
  const centered = (groups: TidyGroup[], pos: number[]) => {
    let groupCenters = 0;
    let anchorCenters = 0;
    let i = 0;
    for (const group of groups) {
      const first = pos[i]! + cardCenter(group.children[0]!.anchor);
      i += group.children.length;
      const last = pos[i - 1]! + cardCenter(group.children.at(-1)!.anchor);
      groupCenters += (first + last) / 2;
      // Middle of the outermost anchors: a couple's midpoint, or a sibling run's center.
      anchorCenters += cardCenter((Math.min(...group.anchors) + Math.max(...group.anchors)) / 2);
    }
    return (groupCenters - anchorCenters) / groups.length;
  };

  const widthOf = (u: TidyUnit) => u.size * m.card + (u.size - 1) * m.couple;

  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]!;
    const block = single(u.level, widthOf(u));

    // Down groups (cousins below an aunt) float: they get a position under
    // their anchors here, clear of the anchor card's column, and are slid
    // outward past whatever shares their row after placement (see below), so
    // they never push the block's own family apart.
    const down = u.downGroups ?? [];
    if (down.length) {
      const items = itemsOf(down);
      const { pos, acc } = pack(items, u.level - 1);
      let x = centered(down, pos);
      const left = u.anchor * step;
      for (let lv = acc.lo; lv <= acc.hi; lv++) {
        if (u.reserve === 'left') {
          const over = acc.off - x + acc.r[lv]! + m.sibling - left;
          if (over > 0) x += over;
        } else {
          const under = left + m.card + m.sibling - (acc.off - x + acc.l[lv]!);
          if (under > 0) x -= under;
        }
      }
      items.forEach((item, k) => (item.unit.rel = pos[k]! - x));
    }

    if (u.groups.length === 0) {
      u.contour = block;
      continue;
    }
    const items = itemsOf(u.groups);
    const { pos, acc } = pack(items, u.level + 1);
    const x = centered(u.groups, pos);
    items.forEach((item, k) => (item.unit.rel = pos[k]! - x));
    acc.off -= x;
    u.contour = merge(acc, block, 0);
  }

  const root = units[0];
  if (!root) return;
  root.x = 0;
  root.contour = undefined;
  for (const u of units) {
    for (const group of u.groups) for (const child of group.children) child.x = u.x + child.rel;
    for (const group of u.downGroups ?? []) {
      for (const child of group.children) child.x = u.x + child.rel;
    }
  }

  // Slide each block's down groups, as one piece, away from the anchor until
  // they clear every other block in their row.
  const floating = new Set(units.flatMap((u) => (u.downGroups ?? []).flatMap((g) => g.children)));
  const rows = new Map<number, [number, number][]>();
  const occupy = (level: number, from: number, to: number) => {
    const row = rows.get(level);
    if (row) row.push([from, to]);
    else rows.set(level, [[from, to]]);
  };
  for (const u of units) if (!floating.has(u)) occupy(u.level, u.x, u.x + widthOf(u));
  for (const u of units) {
    const children = (u.downGroups ?? []).flatMap((g) => g.children);
    if (!children.length) continue;
    const level = u.level - 1;
    let from = Math.min(...children.map((c) => c.x));
    let to = Math.max(...children.map((c) => c.x + widthOf(c)));
    const row = rows.get(level) ?? [];
    for (let moved = true; moved;) {
      moved = false;
      for (const [a, b] of row) {
        if (from >= b + m.sibling || to <= a - m.sibling) continue;
        const shift = u.reserve === 'left' ? a - m.sibling - to : b + m.sibling - from;
        from += shift;
        to += shift;
        for (const c of children) c.x += shift;
        moved = true;
      }
    }
    occupy(level, from, to);
  }
}
