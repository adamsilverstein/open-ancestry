export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MinimapTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Fits world bounds into a canvas of the given size, centered, preserving aspect ratio. */
export function fitTransform(bounds: Rect, width: number, height: number): MinimapTransform {
  if (bounds.width <= 0 || bounds.height <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = Math.min(width / bounds.width, height / bounds.height);
  return {
    scale,
    offsetX: (width - bounds.width * scale) / 2,
    offsetY: (height - bounds.height * scale) / 2,
  };
}

/** Converts a point on the canvas to world coordinates. */
export function toWorld(
  t: MinimapTransform,
  bounds: Rect,
  canvasX: number,
  canvasY: number,
): { x: number; y: number } {
  return {
    x: Math.round((canvasX - t.offsetX) / t.scale + bounds.x),
    y: Math.round((canvasY - t.offsetY) / t.scale + bounds.y),
  };
}
