import { describe, expect, it } from 'vitest';
import { clampGenerations, MAX_GENERATIONS, parseGenerations } from './api';

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

describe('parseGenerations', () => {
  it.each([
    [3, 3],
    ['4', 4],
    [' 2 ', 2],
    ['99', MAX_GENERATIONS],
    ['-1', 0],
    ['', undefined],
    ['   ', undefined],
    ['abc', undefined],
    ['3abc', undefined],
    [null, undefined],
    [undefined, undefined],
    [true, undefined],
    [Number.NaN, undefined],
  ])('%j -> %j', (input, expected) => {
    expect(parseGenerations(input)).toBe(expected);
  });
});
