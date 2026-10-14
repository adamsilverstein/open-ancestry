import type { Rect } from './viewport';

/**
 * Uniform grid over world rects so the renderer can find what intersects the
 * viewport without scanning every card. Items spanning several cells are
 * listed in each.
 */
export class GridIndex {
  private readonly cells = new Map<string, number[]>();
  private readonly items: readonly Rect[];
  private readonly cellSize: number;

  constructor(items: readonly Rect[], cellSize = 512) {
    this.items = items;
    this.cellSize = cellSize;
    items.forEach((item, i) => {
      const [c0, r0, c1, r1] = this.range(item);
      for (let c = c0; c <= c1; c++) {
        for (let r = r0; r <= r1; r++) {
          const key = `${c},${r}`;
          const list = this.cells.get(key);
          if (list) list.push(i);
          else this.cells.set(key, [i]);
        }
      }
    });
  }

  /** Cell column and row span of a rect: [c0, r0, c1, r1]. */
  range(r: Rect): [number, number, number, number] {
    const s = this.cellSize;
    return [
      Math.floor(r.x / s),
      Math.floor(r.y / s),
      Math.floor((r.x + r.width) / s),
      Math.floor((r.y + r.height) / s),
    ];
  }

  /** Indexes of the items intersecting `r`, ascending. */
  query(r: Rect): number[] {
    const [c0, r0, c1, r1] = this.range(r);
    const found = new Set<number>();
    // Few cells hold anything; walk the occupied ones when the range is huge.
    const area = (c1 - c0 + 1) * (r1 - r0 + 1);
    const visit = (list: number[]) => {
      for (const i of list) {
        if (!found.has(i) && intersects(this.items[i]!, r)) found.add(i);
      }
    };
    if (area > this.cells.size) {
      for (const [key, list] of this.cells) {
        const [c, row] = key.split(',').map(Number) as [number, number];
        if (c >= c0 && c <= c1 && row >= r0 && row <= r1) visit(list);
      }
    } else {
      for (let c = c0; c <= c1; c++) {
        for (let row = r0; row <= r1; row++) {
          const list = this.cells.get(`${c},${row}`);
          if (list) visit(list);
        }
      }
    }
    return [...found].sort((a, b) => a - b);
  }
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
  );
}
