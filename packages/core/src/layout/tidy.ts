/**
 * Tidy tree packing along one axis ("breadth"), shared by every vertical and
 * horizontal layout. Each unit is a rigid block of cards on one level (a
 * person with their spouses, or a single ancestor). Its child units are
 * grouped by the card(s) they hang from: a couple's children, or one
 * person's parents in an ancestor tree.
 *
 * Bottom-up, every subtree keeps a contour: its leftmost and rightmost extent
 * per level. Child subtrees are packed left to right, each pushed just far
 * enough that its left contour clears the accumulated right contour on every
 * shared level. The block is then centered over its groups. Contours are
 * arrays indexed by absolute level with a lazy offset, and the deeper of two
 * merged contours is reused, so a merge costs the shallower depth only.
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
  level: number;
  groups: TidyGroup[];
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

/** Lays out `units`, which must list every parent before its children (units[0] is the root). */
export function tidyLayout(units: readonly TidyUnit[], m: TidyMetrics): void {
  const step = m.card + m.couple;
  const anchorCenter = (u: TidyUnit) => u.anchor * step + m.card / 2;

  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]!;
    const width = u.size * m.card + (u.size - 1) * m.couple;
    let acc: Contour | undefined;
    let groupCenters = 0;
    let anchorCenters = 0;
    let groupCount = 0;
    for (const group of u.groups) {
      let first = 0;
      let last = 0;
      for (let j = 0; j < group.children.length; j++) {
        const child = group.children[j]!;
        const cc = child.contour!;
        child.contour = undefined;
        if (!acc) {
          child.rel = 0;
          acc = cc;
        } else {
          let pos = -Infinity;
          const top = Math.min(acc.hi, cc.hi);
          for (let lv = cc.lo; lv <= top; lv++) {
            const gap = lv === cc.lo ? (j > 0 ? group.rootGap : m.sibling) : m.sibling;
            const need = acc.off + acc.r[lv]! + gap - cc.off - cc.l[lv]!;
            if (need > pos) pos = need;
          }
          child.rel = pos;
          const cOff = pos + cc.off;
          if (cc.hi > acc.hi) {
            for (let lv = cc.lo; lv <= acc.hi; lv++) cc.l[lv] = acc.off + acc.l[lv]! - cOff;
            cc.off = cOff;
            acc = cc;
          } else {
            for (let lv = cc.lo; lv <= cc.hi; lv++) acc.r[lv] = cOff + cc.r[lv]! - acc.off;
          }
        }
        const center = child.rel + anchorCenter(child);
        if (j === 0) first = center;
        last = center;
      }
      groupCenters += (first + last) / 2;
      let anchors = 0;
      for (const a of group.anchors) anchors += a * step + m.card / 2;
      anchorCenters += anchors / group.anchors.length;
      groupCount++;
    }

    if (!acc) {
      const l: number[] = [];
      const r: number[] = [];
      l[u.level] = 0;
      r[u.level] = width;
      u.contour = { off: 0, l, r, lo: u.level, hi: u.level };
      continue;
    }
    // Center the block's anchors over the middle of its groups.
    const blockX = (groupCenters - anchorCenters) / groupCount;
    for (const group of u.groups) for (const child of group.children) child.rel -= blockX;
    acc.off -= blockX;
    acc.l[u.level] = -acc.off;
    acc.r[u.level] = width - acc.off;
    acc.lo = u.level;
    u.contour = acc;
  }

  const root = units[0];
  if (!root) return;
  root.x = 0;
  root.contour = undefined;
  for (const u of units) {
    for (const group of u.groups) for (const child of group.children) child.x = u.x + child.rel;
  }
}
