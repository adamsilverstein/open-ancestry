import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { formatLifespan } from '../../lib/lifespan';
import type { PersonSummary } from '../../lib/person';
import { LifespanText } from '../LifespanText/LifespanText';
import { Select } from '../Select/Select';
import styles from './RelationshipChart.module.css';
import { PersonName } from '../PersonName/PersonName';

export type RelationshipChartRole = 'person' | 'between' | 'common-ancestor' | 'home';

export interface RelationshipChartCell {
  /** Null for a family with no recorded parents, shown as "Unknown parents". */
  person: PersonSummary | null;
  /** Generation row, 0 at the top. */
  row: number;
  col: number;
  role: RelationshipChartRole;
  /** How this person relates to the previous one: their parent, child or spouse. */
  step?: 'parent' | 'child' | 'spouse';
}

export interface RelationshipChartPath {
  /** Names the path in the picker and the list, e.g. `1st cousin through Silas Ashdown`. */
  label: string;
  /** In path order, from the person to the home person (core `chartPath`). */
  cells: RelationshipChartCell[];
}

export interface RelationshipChartProps {
  /** Several with pedigree collapse; a picker switches between them. Never empty. */
  paths: RelationshipChartPath[];
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

const STEP_WORDS = {
  parent: ['father', 'mother', 'parent'],
  child: ['son', 'daughter', 'child'],
  spouse: ['husband', 'wife', 'spouse'],
} as const;

/** "father of Felix Ashdown": what a card is to the card before it, for screen readers. */
function stepText(
  cell: RelationshipChartCell,
  previous: RelationshipChartCell | undefined,
): string {
  if (!cell.step || !previous) return 'This person';
  const [male, female, other] = STEP_WORDS[cell.step];
  const sex = cell.person?.sex;
  const word = sex === 'M' ? male : sex === 'F' ? female : other;
  return `${word} of ${previous.person?.name ?? 'unknown parents'}`;
}

/** Name, then lifespan or role, as one spoken phrase: "Horace Ashdown, 1848 to 1910". */
function linkLabel(cell: RelationshipChartCell): string {
  const person = cell.person!;
  const detail = caption[cell.role] ?? formatLifespan(person).replace('–', ' to ');
  return detail ? `${person.name}, ${detail}` : person.name;
}

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
 * Mini chart of how two people are related, with a path picker when pedigree
 * collapse gives several: each person on the path as a
 * small card placed by generation, joined by family lines. Screen readers get
 * the list in path order, each card's name and lifespan, and what each person
 * is to the one before ("father of Felix Ashdown").
 */
export function RelationshipChart({ paths }: RelationshipChartProps) {
  const [index, setIndex] = useState(0);
  const path = paths[Math.min(index, paths.length - 1)]!;
  return (
    <div className={styles.root}>
      {paths.length > 1 && (
        <Select
          label={`Path (${paths.length})`}
          value={String(index)}
          onValueChange={(value) => setIndex(Number(value))}
          options={paths.map((p, i) => ({ value: String(i), label: p.label }))}
        />
      )}
      <Chart cells={path.cells} label={path.label} />
    </div>
  );
}

function Chart({ cells, label }: RelationshipChartPath) {
  const width = Math.max(...cells.map((c) => left(c) + W));
  const height = Math.max(...cells.map((c) => top(c) + H));
  return (
    <div className={styles.chart} style={{ width, height }}>
      <svg className={styles.lines} width={width} height={height} aria-hidden>
        {cells.slice(1).map((cell, i) => (
          <polyline key={i} points={connector(cells[i]!, cell)} />
        ))}
      </svg>
      <ol className={styles.list} aria-label={`Relationship path: ${label}`}>
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
                aria-label={linkLabel(cell)}
              >
                <PersonName className={styles.name} name={cell.person.name} />
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
            <span className="oa-visually-hidden">{`, ${stepText(cell, cells[i - 1])}`}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
