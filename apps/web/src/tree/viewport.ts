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

export const MIN_SCALE = 0.02;
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
