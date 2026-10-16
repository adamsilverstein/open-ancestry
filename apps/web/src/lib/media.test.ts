import { describe, expect, it } from 'vitest';
import { avatarUrl, thumbUrl } from './media';

describe('thumbUrl', () => {
  it('builds the thumbnail endpoint, encoding the tree name', () => {
    expect(thumbUrl('Vale family', 'M1', 'sm')).toBe('/api/trees/Vale%20family/media/M1/thumb/sm');
  });

  it("names the file's version, so replaced bytes are a new URL the image cache has not seen", () => {
    expect(thumbUrl('t', 'M1', 'sm', 'abc123')).toBe('/api/trees/t/media/M1/thumb/sm?v=abc123');
    expect(thumbUrl('t', 'M1', 'sm', null)).toBe('/api/trees/t/media/M1/thumb/sm');
  });
});

describe('avatarUrl', () => {
  it('is the small thumbnail of a local primary photo', () => {
    expect(avatarUrl('t', { primaryMediaId: 'M1', primaryPhotoLocal: true })).toBe(
      '/api/trees/t/media/M1/thumb/sm',
    );
    expect(avatarUrl('t', { primaryMediaId: 'M1', primaryPhotoLocal: true }, 'md')).toMatch(
      /thumb\/md$/,
    );
  });

  it("carries the primary photo's version", () => {
    expect(
      avatarUrl('t', { primaryMediaId: 'M1', primaryPhotoLocal: true, primaryPhotoVersion: 'ab' }),
    ).toBe('/api/trees/t/media/M1/thumb/sm?v=ab');
  });

  it('is undefined (so nothing is requested) without a local primary photo', () => {
    expect(avatarUrl('t', { primaryMediaId: 'M1', primaryPhotoLocal: false })).toBeUndefined();
    expect(avatarUrl('t', { primaryMediaId: null, primaryPhotoLocal: false })).toBeUndefined();
  });
});
