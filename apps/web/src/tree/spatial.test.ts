import { describe, expect, it } from 'vitest';
import { GridIndex } from './spatial';

const rect = (x: number, y: number, width = 100, height = 100) => ({ x, y, width, height });

describe('GridIndex', () => {
  const items = [rect(0, 0), rect(950, 0), rect(-2000, -2000), rect(0, 950, 2000, 10)];
  const index = new GridIndex(items, 500);

  it('returns the items intersecting a rect, in index order', () => {
    expect(index.query(rect(-10, -10, 200, 200))).toEqual([0]);
    expect(index.query(rect(0, 0, 1100, 100))).toEqual([0, 1]);
    expect(index.query(rect(-3000, -3000, 6000, 6000))).toEqual([0, 1, 2, 3]);
  });

  it('finds wide items from any cell they cover, once', () => {
    expect(index.query(rect(1500, 900, 100, 100))).toEqual([3]);
  });

  it('excludes items in a covered cell that do not intersect', () => {
    expect(index.query(rect(200, 200, 50, 50))).toEqual([]);
  });

  it('handles an empty index', () => {
    expect(new GridIndex([], 500).query(rect(0, 0, 10, 10))).toEqual([]);
  });
});
