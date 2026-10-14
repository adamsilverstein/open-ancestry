import { describe, expect, it } from 'vitest';
import { nextIndex } from './roving';

describe('nextIndex', () => {
  it('moves forward and back with wrap-around', () => {
    expect(nextIndex('ArrowRight', 0, 3, 'horizontal')).toBe(1);
    expect(nextIndex('ArrowRight', 2, 3, 'horizontal')).toBe(0);
    expect(nextIndex('ArrowLeft', 0, 3, 'horizontal')).toBe(2);
  });

  it('uses up and down for vertical toolbars', () => {
    expect(nextIndex('ArrowDown', 0, 3, 'vertical')).toBe(1);
    expect(nextIndex('ArrowUp', 0, 3, 'vertical')).toBe(2);
    expect(nextIndex('ArrowRight', 0, 3, 'vertical')).toBeNull();
  });

  it('jumps to ends', () => {
    expect(nextIndex('Home', 2, 3, 'horizontal')).toBe(0);
    expect(nextIndex('End', 0, 3, 'horizontal')).toBe(2);
  });

  it('ignores other keys', () => {
    expect(nextIndex('a', 0, 3, 'horizontal')).toBeNull();
  });
});
