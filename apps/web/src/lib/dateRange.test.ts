import { describe, expect, it } from 'vitest';
import { dateRange, overlaps } from './dateRange';

describe('dateRange', () => {
  it('spans the precision of the date', () => {
    expect(dateRange('12 MAR 1880')).toEqual([18800312, 18800312]);
    expect(dateRange('MAR 1880')).toEqual([18800301, 18800331]);
    expect(dateRange('1880')).toEqual([18800101, 18801231]);
  });

  it('widens approximate dates and opens before/after', () => {
    expect(dateRange('ABT 1890')).toEqual([18890101, 18911231]);
    expect(dateRange('BEF 1900')).toEqual([-Infinity, 19001231]);
    expect(dateRange('AFT 1900')).toEqual([19000101, Infinity]);
    expect(dateRange('BET 1880 AND 1885')).toEqual([18800101, 18851231]);
  });

  it('returns null for empty or unparseable text', () => {
    expect(dateRange(null)).toBeNull();
    expect(dateRange('')).toBeNull();
    expect(dateRange('when the old mill burned')).toBeNull();
  });

  it('overlaps inclusively', () => {
    expect(overlaps([1, 5], [5, 9])).toBe(true);
    expect(overlaps([1, 4], [5, 9])).toBe(false);
  });
});
