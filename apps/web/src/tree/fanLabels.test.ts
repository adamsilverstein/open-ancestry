import { describe, expect, it } from 'vitest';
import type { FanSlot } from '@open-ancestry/core';
import { FAN_LINE_HEIGHT, FAN_RING_WIDTH, fanLabel, labelCandidates } from './fanLabels';

// The tree view's fan geometry: a 60 radius center, FAN_RING_WIDTH rings, the top half.
const slot = (generation: number, index: number): FanSlot => {
  const per = Math.PI / 2 ** generation;
  return {
    ahnentafel: 2 ** generation + index,
    generation,
    startAngle: Math.PI + index * per,
    endAngle: Math.PI + (index + 1) * per,
    innerRadius: generation === 0 ? 0 : 60 + (generation - 1) * FAN_RING_WIDTH,
    outerRadius: 60 + generation * FAN_RING_WIDTH,
  };
};
const measure = (text: string) => text.length * 7;

/** Every point of the label's text block lies inside its segment. */
function contained(s: FanSlot, label: NonNullable<ReturnType<typeof fanLabel>>) {
  const length = Math.max(...label.lines.map(measure));
  const thickness = label.lines.length * FAN_LINE_HEIGHT;
  const a = (label.rotate * Math.PI) / 180;
  for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 10; j++) {
      const u = (i / 10 - 0.5) * length;
      const v = (j / 10 - 0.5) * thickness;
      const x = label.x + u * Math.cos(a) - v * Math.sin(a);
      const y = label.y + u * Math.sin(a) + v * Math.cos(a);
      const r = Math.hypot(x, y);
      let angle = Math.atan2(y, x);
      if (angle < 0) angle += 2 * Math.PI;
      if (r > s.outerRadius || r < s.innerRadius) return false;
      if (angle < s.startAngle || angle > s.endAngle) return false;
    }
  }
  return true;
}

describe('labelCandidates', () => {
  it('goes from the full name and years down to initials', () => {
    expect(labelCandidates('Clementine Ashgrove', '1870–1950')).toEqual([
      ['Clementine Ashgrove', '1870–1950'],
      ['Clementine', 'Ashgrove', '1870–1950'],
      ['Clementine Ashgrove'],
      ['Clementine', 'Ashgrove'],
      ['Clementine'],
      ['C. A.'],
    ]);
  });

  it('handles a single name and no years', () => {
    expect(labelCandidates('Plato', '')).toEqual([['Plato']]);
  });
});

describe('fanLabel', () => {
  it('names the focus person in the center, level', () => {
    const label = fanLabel(slot(0, 0), 'Lily Mosswood', '1990–', measure);
    expect(label?.lines[0]).toBe('Lily Mosswood');
    expect(label?.rotate).toBeCloseTo(0);
  });

  it('runs text across the inner rings, with years', () => {
    const label = fanLabel(slot(1, 0), 'Thomas Ashgrove', '1960–2020', measure)!;
    expect(label.lines).toEqual(['Thomas Ashgrove', '1960–2020']);
  });

  it('runs text along the radius in the thin outer rings, shortening it to fit', () => {
    const s = slot(5, 3);
    const label = fanLabel(s, 'Clementine Ashgrove', '1870–1950', measure)!;
    expect(label.lines).toEqual(['Clementine']);
    const mid = (s.startAngle + s.endAngle) / 2;
    // Along the radius: the text's direction is the segment's middle angle (or its opposite).
    const turn = Math.abs(((label.rotate * Math.PI) / 180 - mid) % Math.PI);
    expect(Math.min(turn, Math.PI - turn)).toBeLessThan(1e-9);
  });

  it('gives up on segments too thin for even initials', () => {
    const tiny: FanSlot = { ...slot(5, 0), endAngle: slot(5, 0).startAngle + 0.01 };
    expect(fanLabel(tiny, 'Ann Lee', '', measure)).toBeNull();
  });

  it('keeps every label inside its segment and upright, on every ring', () => {
    const names = ['Ada Vale', 'Clementine Ashgrove', 'Bartholomew Featherstonehaugh', 'Jo'];
    for (let g = 0; g <= 6; g++) {
      for (let i = 0; i < 2 ** g; i++) {
        for (const name of names) {
          const s = slot(g, i);
          const label = fanLabel(s, name, '1801–1899', measure);
          if (!label) continue;
          expect(contained(s, label), `${name} in ring ${g} slot ${i}`).toBe(true);
          expect(Math.abs(label.rotate)).toBeLessThanOrEqual(90);
        }
      }
    }
  });
});
