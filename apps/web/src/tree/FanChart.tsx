import type { FanLayout, FanSegment } from '@open-ancestry/core';
import { formatLifespan } from '../lib/lifespan';
import type { PersonSummary } from '../lib/person';
import { ancestorTerm } from './relations';
import styles from './TreeView.module.css';

interface FanChartProps {
  fan: FanLayout;
  focusPersonId: string;
  person: (personId: string) => PersonSummary | undefined;
  onRefocus: (personId: string) => void;
}

const point = (r: number, a: number) => `${r * Math.cos(a)} ${r * Math.sin(a)}`;

function arcPath({ startAngle: a0, endAngle: a1, innerRadius: r0, outerRadius: r1 }: FanSegment) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const outer = `M${point(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${point(r1, a1)}`;
  if (r0 === 0) return `${outer}L0 0Z`;
  return `${outer}L${point(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${point(r0, a0)}Z`;
}

/** Fan chart: each ancestor a ring segment in their Ahnentafel slot. Click to re-focus. */
export function FanChart({ fan, focusPersonId, person, onRefocus }: FanChartProps) {
  const focusName = person(focusPersonId)?.name ?? '';
  return (
    <svg className={styles.fan} data-testid="tree-fan">
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
        const label = [p.name, lifespan, relation].filter(Boolean).join(', ');
        const go = () => {
          if (!segment.isFocus) onRefocus(segment.personId);
        };
        return (
          <g
            key={segment.key}
            role="button"
            tabIndex={0}
            aria-label={label}
            className={styles.fanSegment}
            data-sex={p.sex}
            data-focus={segment.isFocus || undefined}
            onClick={go}
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
