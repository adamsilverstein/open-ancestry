import { describe, expect, it } from 'vitest';
import { initials } from './person';

describe('initials', () => {
  it('uses the first and last name', () => {
    expect(initials('Eleanor May Whitcombe')).toBe('EW');
    expect(initials('  thaddeus  ')).toBe('T');
    expect(initials('')).toBe('?');
  });
});
