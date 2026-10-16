import { describe, expect, it } from 'vitest';
import { formatBytes } from './bytes';

describe('formatBytes', () => {
  it('reads like a person would write it', () => {
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5000)).toBe('4.9 KB');
    expect(formatBytes(64 * 1024 ** 2)).toBe('64 MB');
    expect(formatBytes(1_153_434_012)).toBe('1.1 GB');
    expect(formatBytes(1024 ** 3)).toBe('1 GB');
  });
});
