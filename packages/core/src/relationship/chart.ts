/**
 * Grid positions for drawing a relationship path as a mini chart. Rows are
 * generations (0 is the highest person on the path); columns split the climb
 * from A, the descent to B, each marriage and each turn back up:
 *
 *        C            row 0
 *      /   \
 *     P     Q         row 1
 *     |     |
 *     A     B         row 2      A col 0, C col 0, Q and B col 1
 */
import type { RelationshipPath } from './types';

export interface ChartCell {
  id: string;
  row: number;
  col: number;
}

export function chartPath(path: RelationshipPath): ChartCell[] {
  const cells: ChartCell[] = [{ id: path.ids[0]!, row: 0, col: 0 }];
  let row = 0;
  let col = 0;
  let previous: string | undefined;
  path.steps.forEach((step, i) => {
    if (step.kind === 'parent') {
      row -= 1;
      if (previous === 'child') col += 1;
    } else if (step.kind === 'child') {
      row += 1;
      if (previous === 'parent') col += 1;
    } else {
      col += 1;
    }
    previous = step.kind;
    cells.push({ id: path.ids[i + 1]!, row, col });
  });
  const top = Math.min(...cells.map((c) => c.row));
  return cells.map((c) => ({ ...c, row: c.row - top }));
}
