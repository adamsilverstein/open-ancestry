import { describe, expect, it } from 'vitest';
import { clampGenerations, MAX_GENERATIONS } from './api';

describe('clampGenerations', () => {
  it.each([
    [3, 3],
    [10, 10],
    [11, MAX_GENERATIONS],
    [99, MAX_GENERATIONS],
    [-4, 0],
    [2.6, 3],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])('%d -> %d', (input, expected) => {
    expect(clampGenerations(input)).toBe(expected);
  });
});
