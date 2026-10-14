import { describe, expect, it } from 'vitest';
import { formatLifeDate, formatLifespan } from './lifespan';

describe('formatLifeDate', () => {
  it('abbreviates qualifiers', () => {
    expect(formatLifeDate({ year: 1890, qualifier: 'abt' })).toBe('abt. 1890');
    expect(formatLifeDate({ year: 1890, qualifier: 'bef' })).toBe('bef. 1890');
    expect(formatLifeDate({ year: 1890, qualifier: 'aft' })).toBe('aft. 1890');
    expect(formatLifeDate({ year: 1890, qualifier: 'est' })).toBe('est. 1890');
    expect(formatLifeDate({ year: 1890, qualifier: 'cal' })).toBe('cal. 1890');
    expect(formatLifeDate({ year: 1890 })).toBe('1890');
  });
});

describe('formatLifespan', () => {
  it('joins birth and death years with an en dash', () => {
    expect(formatLifespan({ birth: { year: 1911 }, death: { year: 1957 } })).toBe('1911–1957');
  });

  it('shows Living for living people', () => {
    expect(formatLifespan({ birth: { year: 1947 }, living: true })).toBe('1947–Living');
    expect(formatLifespan({ living: true })).toBe('Living');
  });

  it('keeps qualifiers', () => {
    expect(formatLifespan({ birth: { year: 1890, qualifier: 'abt' }, death: { year: 1955 } })).toBe(
      'abt. 1890–1955',
    );
  });

  it('uses b. and d. when only one end is known', () => {
    expect(formatLifespan({ birth: { year: 1820 } })).toBe('b. 1820');
    expect(formatLifespan({ death: { year: 1880 } })).toBe('d. 1880');
  });

  it('is empty when nothing is known', () => {
    expect(formatLifespan({})).toBe('');
  });
});
