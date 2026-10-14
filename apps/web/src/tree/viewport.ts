/**
 * Pan and zoom math for the tree canvas. A transform maps world coordinates
 * (the layout's, focus card at the origin) to viewport pixels:
 * `screen = world * scale + (x, y)`.
 */

export interface Transform {
  x: number;
  y: number;
  scale: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_SCALE = 0.001;
export const MAX_SCALE = 2;
/** One zoom button press or key press. */
export const ZOOM_STEP = 1.25;

export function clampScale(scale: number): number {
  if (Number.isNaN(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Zooms by `factor`, keeping the viewport point (px, py) over the same world point. */
export function zoomAt(t: Transform, px: number, py: number, factor: number): Transform {
  const scale = clampScale(t.scale * factor);
  if (scale === t.scale) return t;
  const ratio = scale / t.scale;
  return { x: px - (px - t.x) * ratio, y: py - (py - t.y) * ratio, scale };
}

/** Fits the bounds in a viewport, centered, never zooming in past 1. */
export function fitBounds(
  bounds: { minX: number; minY: number; width: number; height: number },
  width: number,
  height: number,
  padding: number,
): Transform {
  const scale = clampScale(
    Math.min(
      1,
      (width - 2 * padding) / Math.max(1, bounds.width),
      (height - 2 * padding) / Math.max(1, bounds.height),
    ),
  );
  return {
    x: width / 2 - (bounds.minX + bounds.width / 2) * scale,
    y: height / 2 - (bounds.minY + bounds.height / 2) * scale,
    scale,
  };
}

/** Moves so the world point (wx, wy) is at the viewport center, keeping the scale. */
export function centerOn(
  t: Transform,
  wx: number,
  wy: number,
  width: number,
  height: number,
): Transform {
  return { x: width / 2 - wx * t.scale, y: height / 2 - wy * t.scale, scale: t.scale };
}

/** The part of the world the viewport shows. */
export function visibleWorld(t: Transform, width: number, height: number): Rect {
  return { x: -t.x / t.scale, y: -t.y / t.scale, width: width / t.scale, height: height / t.scale };
}

/** A world rect in viewport pixels. */
export function toScreen(t: Transform, r: Rect): Rect {
  return {
    x: r.x * t.scale + t.x,
    y: r.y * t.scale + t.y,
    width: r.width * t.scale,
    height: r.height * t.scale,
  };
}

export function interpolate(a: Transform, b: Transform, p: number): Transform {
  if (p >= 1) return b;
  return {
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
    scale: a.scale + (b.scale - a.scale) * p,
  };
}

/**
 * Map-style wheel handling. Pinch arrives as ctrl + wheel (and cmd + wheel zooms
 * too). A mouse wheel moves in whole lines or large integer steps on one axis;
 * a trackpad's two-finger scroll sends small, fractional or two-axis deltas,
 * and Shift + wheel scrolls sideways. Wheel and pinch zoom; trackpad scroll pans.
 */
export function wheelKind(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
}): 'pinch' | 'wheel' | 'pan' {
  if (e.ctrlKey || e.metaKey) return 'pinch';
  if (e.shiftKey) return 'pan';
  if (e.deltaMode !== 0) return 'wheel';
  return e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50 ? 'wheel' : 'pan';
}

/** The zoom below which the fan's 12px names would render under 10px. */
export const READABLE_FAN_SCALE = 10 / 12;

interface FanExtent {
  segments: readonly { outerRadius: number }[];
  bounds: { minX: number; minY: number; width: number; height: number };
}

/**
 * Frames the fan's drawn rings, not the empty slots and unused rings past
 * them. When that would shrink names below READABLE_FAN_SCALE (a phone),
 * it keeps them readable instead, centered down the view when it fits.
 */
export function fitFan(fan: FanExtent, width: number, height: number, padding: number): Transform {
  const b = fan.bounds;
  // The bounds are a sector around the origin: scale them to the drawn radius.
  const full = Math.max(-b.minX, b.minX + b.width, -b.minY, b.minY + b.height, 1);
  const k = Math.min(1, Math.max(0, ...fan.segments.map((s) => s.outerRadius)) / full);
  const drawn = { minX: b.minX * k, minY: b.minY * k, width: b.width * k, height: b.height * k };
  const fit = fitBounds(drawn, width, height, padding);
  if (fit.scale >= READABLE_FAN_SCALE) return fit;
  const scale = READABLE_FAN_SCALE;
  // Centered down the screen when it fits; otherwise its base, where the
  // focus person sits, at the bottom.
  const fits = drawn.height * scale <= height - 2 * padding;
  return {
    x: width / 2 - (drawn.minX + drawn.width / 2) * scale,
    y: fits
      ? height / 2 - (drawn.minY + drawn.height / 2) * scale
      : height - padding - (drawn.minY + drawn.height) * scale,
    scale,
  };
}
