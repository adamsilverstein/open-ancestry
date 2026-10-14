import { Link } from '@tanstack/react-router';
import type { PersonSummary } from '../../lib/person';
import { LifespanText } from '../LifespanText/LifespanText';
import styles from './RelationshipChart.module.css';

export type RelationshipChartRole = 'person' | 'between' | 'common-ancestor' | 'home';

export interface RelationshipChartCell {
  /** Null for a family with no recorded parents, shown as "Unknown parents". */
  person: PersonSummary | null;
  /** Generation row, 0 at the top. */
  row: number;
  col: number;
  role: RelationshipChartRole;
}

export interface RelationshipChartProps {
  /** In path order, from the person to the home person (core `chartPath`). */
  cells: RelationshipChartCell[];
  label?: string;
}

const W = 148;
const H = 56;
const GAP_X = 20;
const GAP_Y = 28;

const left = (c: RelationshipChartCell) => c.col * (W + GAP_X);
const top = (c: RelationshipChartCell) => c.row * (H + GAP_Y);

const caption: Partial<Record<RelationshipChartRole, string>> = {
  'common-ancestor': 'Common ancestor',
  home: 'Home person',
};

/** Connector between two consecutive cells: straight, elbow or spouse line. */
function connector(a: RelationshipChartCell, b: RelationshipChartCell): string {
  const [upper, lower] = a.row <= b.row ? [a, b] : [b, a];
  if (a.row === b.row) {
    const [l, r] = a.col < b.col ? [a, b] : [b, a];
    const y = top(l) + H / 2;
    return `${left(l) + W},${y} ${left(r)},${y}`;
  }
  const x1 = left(upper) + W / 2;
  const x2 = left(lower) + W / 2;
  const y1 = top(upper) + H;
  const y2 = top(lower);
  const mid = y1 + GAP_Y / 2;
  return `${x1},${y1} ${x1},${mid} ${x2},${mid} ${x2},${y2}`;
}

/**
 * Mini chart of how two people are related: each person on the path as a
 * small card placed by generation, joined by family lines. The list reads in
 * path order for screen readers.
 */
export function RelationshipChart({ cells, label = 'Relationship path' }: RelationshipChartProps) {
  const width = Math.max(...cells.map((c) => left(c) + W));
  const height = Math.max(...cells.map((c) => top(c) + H));
  return (
    <div className={styles.chart} style={{ width, height }}>
      <svg className={styles.lines} width={width} height={height} aria-hidden>
        {cells.slice(1).map((cell, i) => (
          <polyline key={i} points={connector(cells[i]!, cell)} />
        ))}
      </svg>
      <ol className={styles.list} aria-label={label}>
        {cells.map((cell, i) => (
          <li
            key={`${cell.person?.id ?? 'unknown'}-${i}`}
            className={styles.cell}
            data-role={cell.role}
            style={{ left: left(cell), top: top(cell), width: W, height: H }}
          >
            {cell.person ? (
              <Link
                to="/person/$personId"
                params={{ personId: cell.person.id }}
                className={styles.card}
              >
                <span className={styles.name}>{cell.person.name}</span>
                <span className={styles.meta}>
                  {caption[cell.role] ?? <LifespanText {...cell.person} />}
                </span>
              </Link>
            ) : (
              <span className={styles.card}>
                <span className={styles.name}>Unknown parents</span>
                <span className={styles.meta}>{caption[cell.role]}</span>
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
