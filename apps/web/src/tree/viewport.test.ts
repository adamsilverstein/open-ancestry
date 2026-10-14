import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  centerOn,
  clampScale,
  fitBounds,
  interpolate,
  toScreen,
  visibleWorld,
  zoomAt,
} from './viewport';

describe('viewport math', () => {
  it('clamps the scale', () => {
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(0.5)).toBe(0.5);
  });

  it('zooms around a screen point, keeping it fixed', () => {
    const t = { x: 100, y: 50, scale: 1 };
    const next = zoomAt(t, 300, 200, 2);
    expect(next.scale).toBe(2);
    // The world point under (300, 200) before and after is the same.
    const before = { x: (300 - t.x) / t.scale, y: (200 - t.y) / t.scale };
    const after = { x: (300 - next.x) / next.scale, y: (200 - next.y) / next.scale };
    expect(after).toEqual(before);
  });

  it('does not move when the zoom is already at a limit', () => {
    const t = { x: 10, y: 20, scale: MAX_SCALE };
    expect(zoomAt(t, 50, 50, 2)).toEqual(t);
  });

  it('fits bounds inside the viewport with padding, centered', () => {
    const t = fitBounds({ minX: 0, minY: 0, width: 1000, height: 500 }, 600, 400, 50);
    expect(t.scale).toBeCloseTo(0.5);
    expect(t.x).toBeCloseTo(50);
    expect(t.y).toBeCloseTo(75);
  });

  it('never zooms in past 1 when fitting a small tree', () => {
    const t = fitBounds({ minX: -60, minY: -75, width: 120, height: 150 }, 1000, 800, 40);
    expect(t.scale).toBe(1);
    expect(t.x).toBe(500);
    expect(t.y).toBe(400);
  });

  it('centers a world point and reports the visible world rect', () => {
    const t = centerOn({ x: 0, y: 0, scale: 2 }, 100, 50, 800, 600);
    expect(t).toEqual({ x: 200, y: 200, scale: 2 });
    expect(visibleWorld(t, 800, 600)).toEqual({ x: -100, y: -100, width: 400, height: 300 });
  });

  it('projects world rects to the screen', () => {
    expect(
      toScreen({ x: 10, y: 20, scale: 0.5 }, { x: 100, y: 40, width: 120, height: 150 }),
    ).toEqual({ x: 60, y: 40, width: 60, height: 75 });
  });

  it('interpolates transforms', () => {
    const a = { x: 0, y: 0, scale: 1 };
    const b = { x: 100, y: -100, scale: 2 };
    expect(interpolate(a, b, 0)).toEqual(a);
    expect(interpolate(a, b, 1)).toEqual(b);
    expect(interpolate(a, b, 0.5)).toEqual({ x: 50, y: -50, scale: 1.5 });
  });
});
