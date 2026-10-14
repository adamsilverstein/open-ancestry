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
 * shared level. The block is then centered over its groups. When a child
 * subtree reaches back down to the block's own level (cousins beside the
 * focus row), the block and its `downGroups` are packed in line between the
 * children on its left and right instead, so nothing overlaps.
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
  /** Keeps `downGroups` entirely left or right (the default) of the anchor card. */
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

function clone(c: Contour): Contour {
  return { ...c, l: c.l.slice(), r: c.r.slice() };
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
  const pack = (items: Item[], rootLevel: number, mutate: boolean) => {
    let acc: Contour | undefined;
    const pos: number[] = [];
    for (const item of items) {
      const c = mutate ? item.contour : clone(item.contour);
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

  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]!;
    const width = u.size * m.card + (u.size - 1) * m.couple;

    // The block with its down groups (cousins below an aunt), in block frame.
    let block = single(u.level, width);
    const down = u.downGroups ?? [];
    if (down.length) {
      const items = itemsOf(down);
      const { pos, acc } = pack(items, u.level - 1, true);
      let x = centered(down, pos);
      {
        // Slide the down groups clear of the anchor card's column.
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
      }
      items.forEach((item, k) => (item.unit.rel = pos[k]! - x));
      acc.off -= x;
      block = merge(acc, block, 0);
    }

    if (u.groups.length === 0) {
      u.contour = block;
      continue;
    }
    const items = itemsOf(u.groups);
    const inline = items.some((item) => item.contour.lo <= u.level);
    if (!inline) {
      const { pos, acc } = pack(items, u.level + 1, true);
      const x = centered(u.groups, pos);
      items.forEach((item, k) => (item.unit.rel = pos[k]! - x));
      acc.off -= x;
      u.contour = merge(acc, block, 0);
      continue;
    }

    // A child reaches the block's level: pack the block between the children
    // left and right of its natural, centered spot.
    const natural = pack(items, u.level + 1, false).pos;
    const x0 = centered(u.groups, natural);
    // The block goes after every child whose subtree reaches its level on the
    // left (an aunt's children beside a father), before the rest.
    const after = (item: Item, k: number) => {
      const c = item.contour;
      const l = c.lo <= u.level ? c.l[u.level] : undefined;
      if (l === undefined) {
        return natural[k]! + cardCenter(item.unit.anchor) < x0 + cardCenter(u.anchor);
      }
      return c.off + (l + c.r[u.level]!) / 2 < cardCenter(item.unit.anchor);
    };
    let split = 0;
    while (split < items.length && after(items[split]!, split)) split++;
    let acc: Contour | undefined;
    /** Places `c` at `at` or further right, clear of everything placed so far. */
    const place = (c: Contour, at: number, gapAt: (lv: number) => number) => {
      if (!acc) {
        c.off += at;
        acc = c;
        return at;
      }
      const p = Math.max(at, separation(acc, c, gapAt));
      acc = merge(acc, c, p);
      return p;
    };
    let x = x0;
    const pos: number[] = [];
    items.forEach((item, k) => {
      if (k === split) x = place(block, x0, () => m.sibling);
      const gapAt = (lv: number) => (lv === u.level + 1 ? item.rootGap : m.sibling);
      pos.push(place(item.contour, natural[k]!, gapAt));
    });
    if (split === items.length) x = place(block, x0, () => m.sibling);
    items.forEach((item, k) => (item.unit.rel = pos[k]! - x));
    acc!.off -= x;
    u.contour = acc;
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
}
