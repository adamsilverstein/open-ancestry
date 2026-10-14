import { describe, expect, it } from 'vitest';
import { fitTransform, toWorld } from './minimap';

describe('fitTransform', () => {
  it('scales world bounds into the canvas preserving aspect ratio and centering', () => {
    const t = fitTransform({ x: 0, y: 0, width: 1000, height: 500 }, 200, 200);
    expect(t.scale).toBeCloseTo(0.2);
    expect(t.offsetX).toBeCloseTo(0);
    expect(t.offsetY).toBeCloseTo(50);
  });

  it('handles empty bounds', () => {
    const t = fitTransform({ x: 0, y: 0, width: 0, height: 0 }, 100, 100);
    expect(t.scale).toBe(1);
  });
});

describe('toWorld', () => {
  it('maps canvas coordinates back to world coordinates', () => {
    const bounds = { x: -100, y: 0, width: 1000, height: 500 };
    const t = fitTransform(bounds, 200, 200);
    expect(toWorld(t, bounds, 100, 100)).toEqual({ x: 400, y: 250 });
  });
});
