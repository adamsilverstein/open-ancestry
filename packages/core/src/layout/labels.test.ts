import { describe, expect, it } from 'vitest';
import { generationLabel } from './index';

describe('generationLabel', () => {
  it.each([
    [0, ''],
    [-1, 'Parents'],
    [-2, 'Grandparents'],
    [-3, 'Great-grandparents'],
    [-4, '2nd great-grandparents'],
    [-5, '3rd great-grandparents'],
    [-6, '4th great-grandparents'],
    [-13, '11th great-grandparents'],
    [-23, '21st great-grandparents'],
    [1, 'Children'],
    [2, 'Grandchildren'],
    [3, 'Great-grandchildren'],
    [4, '2nd great-grandchildren'],
  ])('labels generation %i as "%s"', (generation, text) => {
    expect(generationLabel(generation)).toBe(text);
  });
});
