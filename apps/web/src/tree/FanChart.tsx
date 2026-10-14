import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { FanLayout, FanSegment, FanSlot } from '@open-ancestry/core';
import { formatLifespan } from '../lib/lifespan';
import type { PersonSummary } from '../lib/person';
import { FAN_LINE_HEIGHT, canvasMeasure, fanLabel, type Measure } from './fanLabels';
import { ancestorTerm } from './relations';
import styles from './TreeView.module.css';

interface FanChartProps {
  fan: FanLayout;
  focusPersonId: string;
  person: (personId: string) => PersonSummary | undefined;
  onRefocus: (personId: string) => void;
}

const point = (r: number, a: number) => `${r * Math.cos(a)} ${r * Math.sin(a)}`;

function arcPath({ startAngle: a0, endAngle: a1, innerRadius: r0, outerRadius: r1 }: FanSlot) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const outer = `M${point(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${point(r1, a1)}`;
  if (r0 === 0) return `${outer}L0 0Z`;
  return `${outer}L${point(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${point(r0, a0)}Z`;
}

/** Font size of the fan's text (`--oa-text-xs`). */
const FAN_FONT_SIZE = 12;

/**
 * Text widths in the fan's font, measured on a canvas (no layout). Measured
 * again once web fonts load, since the fallback font has other widths.
 */
function useMeasure(): Measure {
  const [fontsLoaded, setFontsLoaded] = useState(0);
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) setFontsLoaded((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, []);
  // fontsLoaded: measure again in the loaded font.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => canvasMeasure(FAN_FONT_SIZE), [fontsLoaded]);
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
export function FanChart({ fan, focusPersonId, person, onRefocus }: FanChartProps) {
  const focusName = person(focusPersonId)?.name ?? '';
  const svgRef = useRef<SVGSVGElement>(null);
  const center = useMemo(() => fan.segments.find((s) => s.isFocus)?.key ?? null, [fan]);
  // The roving tab stop, reset to the center for each fan.
  const [roving, setRoving] = useState<{ fan: FanLayout; key: string | null }>({
    fan,
    key: center,
  });
  const active =
    roving.fan === fan && fan.segments.some((s) => s.key === roving.key) ? roving.key : center;

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const from = fan.segments.find((s) => s.key === active);
    if (!from || event.altKey || event.ctrlKey || event.metaKey) return;
    const next = fanNeighbor(fan.segments, from, event.key);
    if (!next) return;
    event.preventDefault();
    // Keep the canvas from also handling the key (it pans on arrows).
    event.stopPropagation();
    setRoving({ fan, key: next.key });
    svgRef.current
      ?.querySelector<SVGGElement>(`[data-key="${CSS.escape(next.key)}"]`)
      ?.focus({ preventScroll: true });
  }

  const measure = useMeasure();
  // The best text that fits each segment, worked out once per fan.
  const labels = useMemo(
    () =>
      new Map(
        fan.segments.map((segment) => {
          const p = person(segment.personId);
          return [
            segment.key,
            p ? fanLabel(segment, p, formatLifespan(p), measure) : null,
          ] as const;
        }),
      ),
    [fan, person, measure],
  );
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
        const lifespan = formatLifespan(p);
        const relation = segment.isFocus
          ? 'focus person'
          : `${ancestorTerm(segment.generation, p.sex)} of ${focusName}`;
        const label = [p.name, lifespan, relation].filter(Boolean).join(', ');
        const text = labels.get(segment.key);
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
            onClick={go}
            onFocus={() => setRoving({ fan, key: segment.key })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                go();
              }
            }}
          >
            <path d={arcPath(segment)} />
            {text && (
              <text
                transform={`translate(${text.x} ${text.y}) rotate(${text.rotate})`}
                textAnchor="middle"
                dominantBaseline="central"
                aria-hidden
              >
                {text.lines.map((line, i) => (
                  <tspan key={i} x={0} y={(i - (text.lines.length - 1) / 2) * FAN_LINE_HEIGHT}>
                    {line}
                  </tspan>
                ))}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
