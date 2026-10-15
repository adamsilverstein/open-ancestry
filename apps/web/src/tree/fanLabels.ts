import type { FanSlot } from '@open-ancestry/core';

/*
 * Fan chart segment labels. Inner rings are wide arcs, so text runs across
 * them (tangential); outer rings are long and thin, so text runs along the
 * radius. Each person gets the most informative text that fits inside their
 * segment: full name and years, name split over lines, name, first name
 * and surname, given names, initials, a shortened name, or nothing (the
 * segment's accessible name always has everything).
 */

/**
 * Ring width the tree view lays the fan out with: wider than the layout's
 * default so a first name fits along the radius of the thin outer rings.
 */
export const FAN_RING_WIDTH = 80;
/** Line height of the fan's text (`--oa-text-xs`), in world units. */
export const FAN_LINE_HEIGHT = 16;
/** Clear space between a label and its segment's edges. */
const PAD = 4;

export type Measure = (text: string) => number;

/**
 * Text widths in the app's sans font at `size`, from a canvas: no layout.
 * Without a canvas (tests), a generous average glyph width.
 */
export function canvasMeasure(size: number): Measure {
  const context = document.createElement('canvas').getContext('2d');
  const family = getComputedStyle(document.documentElement).getPropertyValue('--oa-font-sans');
  if (context) context.font = `${size}px ${family.trim() || 'sans-serif'}`;
  const widths = new Map<string, number>();
  return (text) => {
    let width = widths.get(text);
    if (width === undefined) {
      width = context ? context.measureText(text).width : text.length * size * 0.6;
      widths.set(text, width);
    }
    return width;
  };
}

export interface FanLabel {
  lines: string[];
  /** Center of the text block. */
  x: number;
  y: number;
  /** Degrees; text always reads left to right or bottom to top. */
  rotate: number;
}

/** A person's name, as stored: the full display name and its parts. */
export interface FanName {
  name: string;
  given?: string | undefined;
  surname?: string | undefined;
}

const graphemes = (text: string) =>
  [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
    (s) => s.segment,
  );

/**
 * Text options, most informative first: name and years, name, first given
 * name with the surname (then its initial), given names, initials, and last
 * the name cut short. Parts come from the stored given name and surname,
 * never from splitting on spaces, which would make "Jr." a surname.
 */
export function labelCandidates(
  { name, given = '', surname = '' }: FanName,
  lifespan: string,
): string[][] {
  const first = given.trim().split(/\s+/)[0] ?? '';
  const initial = (text: string) => (text ? `${graphemes(text)[0]}.` : '');
  const options: string[][] = [];
  const add = (...lines: string[]) => {
    const kept = lines.filter(Boolean);
    if (kept.length && !options.some((o) => o.join('\n') === kept.join('\n'))) options.push(kept);
  };
  if (lifespan) {
    add(name, lifespan);
    if (given && surname) add(given, surname, lifespan);
  }
  add(name);
  if (given && surname) {
    add(given, surname);
    if (first !== given) add(`${first} ${surname}`);
    add(first, surname);
    add(`${first} ${initial(surname)}`);
  }
  if (given && first !== given) add(given);
  add(first || name);
  if (given && surname) add(`${initial(given)} ${initial(surname)}`);
  // Last, the first name (or the whole name, for one word) cut short.
  const word = graphemes(first || name);
  for (let n = word.length - 1; n >= 1; n--) add(`${word.slice(0, n).join('')}…`);
  return options;
}

const TAU = 2 * Math.PI;
const degrees = (radians: number) => (radians * 180) / Math.PI;
/** Into (-180, 180]. */
const normalize = (deg: number) => {
  const d = ((((deg + 180) % 360) + 360) % 360) - 180;
  return d === -180 ? 180 : d;
};

/** True when the point lies inside the segment, PAD clear of its edges. */
function inside(slot: FanSlot, x: number, y: number): boolean {
  const r = Math.hypot(x, y);
  if (r > slot.outerRadius - PAD) return false;
  if (slot.innerRadius > 0 && r < slot.innerRadius + PAD) return false;
  const mid = (slot.startAngle + slot.endAngle) / 2;
  const offset = ((((Math.atan2(y, x) - mid) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
  const half = (slot.endAngle - slot.startAngle) / 2 - PAD / Math.max(r, PAD);
  return Math.abs(offset) <= half;
}

type Orientation = 'across' | 'along';

/**
 * Whether a text block `length` long and `thickness` thick, centered `radius`
 * from the fan's center on the segment's middle angle, fits the segment.
 */
function fits(
  slot: FanSlot,
  orientation: Orientation,
  radius: number,
  length: number,
  thickness: number,
): boolean {
  const mid = (slot.startAngle + slot.endAngle) / 2;
  const n = [Math.cos(mid), Math.sin(mid)] as const;
  const t = [-n[1], n[0]] as const;
  // u runs along the text, v across its lines.
  const [u, v] = orientation === 'across' ? [t, n] : [n, t];
  const [halfU, halfV] = [length / 2, thickness / 2];
  const at = (a: number, b: number) =>
    [radius * n[0] + a * u[0] + b * v[0], radius * n[1] + a * u[1] + b * v[1]] as const;
  const points = [at(-halfU, -halfV), at(halfU, -halfV), at(-halfU, halfV), at(halfU, halfV)];
  // The middle of the edge nearest the center: the inner arc curves into it.
  points.push(orientation === 'across' ? at(0, -halfV) : at(-halfU, 0));
  return points.every(([x, y]) => inside(slot, x, y));
}

/** The label to draw in a segment, or null when not even initials fit. */
export function fanLabel(
  slot: FanSlot,
  name: FanName,
  lifespan: string,
  measure: Measure,
): FanLabel | null {
  const mid = (slot.startAngle + slot.endAngle) / 2;
  const middle = (slot.innerRadius + slot.outerRadius) / 2;
  for (const lines of labelCandidates(name, lifespan)) {
    const length = Math.max(...lines.map(measure));
    const thickness = lines.length * FAN_LINE_HEIGHT;
    const tries: [Orientation, number][] =
      slot.innerRadius === 0
        ? // The focus half-disc: as low as the base allows, where it is widest.
          [0, 6, 12].map((lift) => ['across', thickness / 2 + PAD + lift])
        : [
            ['across', middle],
            ['along', middle],
          ];
    for (const [orientation, radius] of tries) {
      if (!fits(slot, orientation, radius, length, thickness)) continue;
      const along = degrees(mid);
      const turn = normalize(orientation === 'across' ? along + 90 : along);
      return {
        lines,
        x: radius * Math.cos(mid),
        y: radius * Math.sin(mid),
        rotate: Math.abs(turn) > 90 ? normalize(turn + 180) : turn,
      };
    }
  }
  return null;
}
