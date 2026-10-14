import { describe, expect, it } from 'vitest';
import { isChunkLoadError } from './chunkError';

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: http://x/assets/a.js',
    'Importing a module script failed.',
    'error loading dynamically imported module',
  ])('recognizes %j', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isChunkLoadError(new Error('Person not found'))).toBe(false);
    expect(isChunkLoadError('nope')).toBe(false);
  });
});
