import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { FanLayout, FanSegment, FanSlot } from '@open-ancestry/core';
import { formatLifespan } from '../lib/lifespan';
import type { PersonSummary } from '../lib/person';
import { ancestorTerm } from './relations';
import styles from './TreeView.module.css';

interface FanChartProps {
  fan: FanLayout;
  focusPersonId: string;
  person: (personId: string) => PersonSummary | undefined;
  onRefocus: (personId: string) => void;
  /** Highlight by tag, as on the cards: these people are marked, the rest dimmed. */
  highlight?: { personIds: ReadonlySet<string>; label: string } | null;
}

const point = (r: number, a: number) => `${r * Math.cos(a)} ${r * Math.sin(a)}`;

function arcPath({ startAngle: a0, endAngle: a1, innerRadius: r0, outerRadius: r1 }: FanSlot) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const outer = `M${point(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${point(r1, a1)}`;
  if (r0 === 0) return `${outer}L0 0Z`;
  return `${outer}L${point(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${point(r0, a0)}Z`;
}

/**
 * The segment an arrow key moves to: up to the parent ring (the father's side,
 * else the mother's), down toward the center, left and right along the ring.
 */
function fanNeighbor(
  segments: readonly FanSegment[],
  from: FanSegment,
  key: string,
): FanSegment | undefined {
  const byNumber = new Map(segments.map((s) => [s.ahnentafel, s]));
  const n = from.ahnentafel;
  if (key === 'ArrowUp') return byNumber.get(2 * n) ?? byNumber.get(2 * n + 1);
  if (key === 'ArrowDown') return n > 1 ? byNumber.get(Math.floor(n / 2)) : undefined;
  if (key === 'Home') return byNumber.get(1);
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined;
  const ring = segments
    .filter((s) => s.generation === from.generation)
    .sort((a, b) => a.startAngle - b.startAngle);
  return ring[ring.indexOf(from) + (key === 'ArrowLeft' ? -1 : 1)];
}

/**
 * Fan chart: each ancestor a ring segment in their Ahnentafel slot. Click to
 * re-focus. Unknown parents of shown ancestors are drawn as empty dashed slots
 * (decorative: the chart's buttons already say who is shown). One Tab stop
 * (roving tabindex): arrows move by relationship and Home returns to the center.
 */
export function FanChart({
  fan,
  focusPersonId,
  person,
  onRefocus,
  highlight = null,
}: FanChartProps) {
  const focusName = person(focusPersonId)?.name ?? '';
  const svgRef = useRef<SVGSVGElement>(null);
  // Only drawn segments (their person is loaded) can hold the tab stop.
  const drawn = useMemo(
    () => fan.segments.filter((s) => person(s.personId) !== undefined),
    [fan, person],
  );
  const center = drawn.find((s) => s.isFocus)?.key ?? drawn[0]?.key ?? null;
  // The roving tab stop, by layout key: it survives a rebuild of the same fan
  // (a reload) and starts at the center for a new focus person.
  const [roving, setRoving] = useState<{ focus: string; key: string | null }>({
    focus: focusPersonId,
    key: center,
  });
  const active =
    roving.focus === focusPersonId && drawn.some((s) => s.key === roving.key) ? roving.key : center;

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const from = drawn.find((s) => s.key === active);
    if (!from || event.altKey || event.ctrlKey || event.metaKey) return;
    const next = fanNeighbor(drawn, from, event.key);
    if (!next) return;
    event.preventDefault();
    // Keep the canvas from also handling the key (it pans on arrows).
    event.stopPropagation();
    setRoving({ focus: focusPersonId, key: next.key });
    svgRef.current
      ?.querySelector<SVGGElement>(`[data-key="${CSS.escape(next.key)}"]`)
      ?.focus({ preventScroll: true });
  }

  return (
    // A group, not the default img role, which would make the segment buttons presentational.
    <svg
      ref={svgRef}
      className={styles.fan}
      data-testid="tree-fan"
      role="group"
      aria-label="Fan chart"
      onKeyDown={onKeyDown}
    >
      {fan.emptySlots.map((slot) => (
        <path
          key={`empty-${slot.ahnentafel}`}
          d={arcPath(slot)}
          className={styles.fanEmpty}
          data-testid="fan-empty-slot"
          aria-hidden="true"
        />
      ))}
      {fan.segments.map((segment) => {
        const p = person(segment.personId);
        if (!p) return null;
        const mid = (segment.startAngle + segment.endAngle) / 2;
        const radius =
          segment.innerRadius === 0
            ? segment.outerRadius / 2
            : (segment.innerRadius + segment.outerRadius) / 2;
        const arc = (segment.endAngle - segment.startAngle) * radius;
        const lifespan = formatLifespan(p);
        const relation = segment.isFocus
          ? 'focus person'
          : `${ancestorTerm(segment.generation, p.sex)} of ${focusName}`;
        const highlighted = highlight?.personIds.has(segment.personId) ?? false;
        const label = [p.name, lifespan, relation, highlighted && highlight!.label]
          .filter(Boolean)
          .join(', ');
        const go = () => {
          if (!segment.isFocus) onRefocus(segment.personId);
        };
        return (
          <g
            key={segment.key}
            role="button"
            tabIndex={segment.key === active ? 0 : -1}
            aria-label={label}
            data-key={segment.key}
            className={styles.fanSegment}
            data-sex={p.sex}
            data-focus={segment.isFocus || undefined}
            data-highlighted={highlighted || undefined}
            data-dimmed={(highlight !== null && !highlighted) || undefined}
            onClick={go}
            onFocus={() => setRoving({ focus: focusPersonId, key: segment.key })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                go();
              }
            }}
          >
            <path d={arcPath(segment)} />
            {arc > 36 && (
              <text
                x={radius * Math.cos(mid)}
                y={segment.innerRadius === 0 ? -radius / 2 : radius * Math.sin(mid)}
                textAnchor="middle"
                dominantBaseline="middle"
                aria-hidden
              >
                {p.name.split(' ')[0]}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
