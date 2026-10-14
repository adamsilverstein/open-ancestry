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

const named = (given: string, surname: string) => ({
  name: [given, surname].filter(Boolean).join(' '),
  given,
  surname,
});
const LONG = named('Maria Theresia Wilhelmina Katharina', 'van Hoek');

describe('labelCandidates', () => {
  it('goes from the full name and years down to initials', () => {
    expect(labelCandidates(named('Clementine', 'Ashgrove'), '1870–1950').slice(0, 7)).toEqual([
      ['Clementine Ashgrove', '1870–1950'],
      ['Clementine', 'Ashgrove', '1870–1950'],
      ['Clementine Ashgrove'],
      ['Clementine', 'Ashgrove'],
      ['Clementine A.'],
      ['Clementine'],
      ['C. A.'],
    ]);
  });

  it('tries the first given name with the surname before initials', () => {
    const options = labelCandidates(LONG, '').map((o) => o.join(' / '));
    const at = (text: string) => options.indexOf(text);
    expect(at('Maria van Hoek')).toBeGreaterThan(-1);
    expect(at('Maria van Hoek')).toBeLessThan(at('Maria v.'));
    expect(at('Maria v.')).toBeLessThan(at('Maria'));
    expect(at('Maria')).toBeLessThan(at('M. v.'));
  });

  it('uses the stored surname, not the last word ("Jr." is no surname)', () => {
    const options = labelCandidates(
      { name: 'John Smith Jr.', given: 'John', surname: 'Smith' },
      '',
    );
    expect(options).toContainEqual(['John Smith Jr.']);
    expect(options).toContainEqual(['John', 'Smith']);
    expect(options).toContainEqual(['J. S.']);
    expect(options.flat()).not.toContain('Jr.');
  });

  it('keeps astral characters whole in initials and truncations', () => {
    const options = labelCandidates(named('𝒜lice', 'Zed'), '');
    expect(options).toContainEqual(['𝒜. Z.']);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const line of options.flat()) expect(line).not.toMatch(lone);
  });

  it('truncates a single-word name rather than drop it', () => {
    const options = labelCandidates(named('山田花子', ''), '');
    expect(options[0]).toEqual(['山田花子']);
    expect(options).toContainEqual(['山田…']);
  });

  it('handles a single name and no years', () => {
    expect(labelCandidates(named('Plato', ''), '')[0]).toEqual(['Plato']);
  });
});

describe('fanLabel', () => {
  it('names the focus person in the center, level', () => {
    const label = fanLabel(slot(0, 0), named('Lily', 'Mosswood'), '1990–', measure);
    expect(label?.lines[0]).toBe('Lily Mosswood');
    expect(label?.rotate).toBeCloseTo(0);
  });

  it('runs text across the inner rings, with years', () => {
    const label = fanLabel(slot(1, 0), named('Thomas', 'Ashgrove'), '1960–2020', measure)!;
    expect(label.lines).toEqual(['Thomas Ashgrove', '1960–2020']);
  });

  it('runs text along the radius in the thin outer rings, shortening it to fit', () => {
    const s = slot(5, 3);
    const label = fanLabel(s, named('Clementine', 'Ashgrove'), '1870–1950', measure)!;
    expect(label.lines).toEqual(['Clementine']);
    const mid = (s.startAngle + s.endAngle) / 2;
    // Along the radius: the text's direction is the segment's middle angle (or its opposite).
    const turn = Math.abs(((label.rotate * Math.PI) / 180 - mid) % Math.PI);
    expect(Math.min(turn, Math.PI - turn)).toBeLessThan(1e-9);
  });

  it('names a long name in a wide ring by first name and surname, not initials', () => {
    const label = fanLabel(slot(2, 1), LONG, '1801–1880', measure)!;
    expect(label.lines.join(' ')).toContain('Maria');
    expect(label.lines.join(' ')).toContain('van Hoek');
  });

  it('shows a truncated single-word name in a thin outer ring', () => {
    const label = fanLabel(slot(5, 7), named('山田花子', ''), '', (t) => [...t].length * 14);
    expect(label?.lines[0]).toMatch(/…$|^山田花子$/);
  });

  it('gives up on segments too thin for even initials', () => {
    const tiny: FanSlot = { ...slot(5, 0), endAngle: slot(5, 0).startAngle + 0.01 };
    expect(fanLabel(tiny, named('Ann', 'Lee'), '', measure)).toBeNull();
  });

  it('keeps every label inside its segment and upright, on every ring', () => {
    const names = [
      named('Ada', 'Vale'),
      named('Clementine', 'Ashgrove'),
      named('Bartholomew', 'Featherstonehaugh'),
      named('Jo', ''),
      LONG,
      named('山田花子', ''),
    ];
    for (let g = 0; g <= 6; g++) {
      for (let i = 0; i < 2 ** g; i++) {
        for (const name of names) {
          const s = slot(g, i);
          const label = fanLabel(s, name, '1801–1899', measure);
          if (!label) continue;
          expect(contained(s, label), `${name.name} in ring ${g} slot ${i}`).toBe(true);
          expect(Math.abs(label.rotate)).toBeLessThanOrEqual(90);
        }
      }
    }
  });
});
