import type { MediaRow } from '@open-ancestry/db';
import { describe, expect, it } from 'vitest';
import { hasThumbnail, mediaGroup, thumbUrl } from './api';

const media = (fields: Partial<MediaRow>) =>
  ({ kind: 'photo', local_path: null, ...fields }) as MediaRow;

describe('gallery helpers', () => {
  it('groups media for the type filter', () => {
    expect(mediaGroup(media({ local_path: 'a.jpg' }))).toBe('photos');
    expect(mediaGroup(media({ local_path: 'a.pdf', kind: 'document' }))).toBe('documents');
    expect(mediaGroup(media({ local_path: 'a.bin', kind: 'other' }))).toBe('documents');
    expect(mediaGroup(media({ local_path: 'a.mp3', kind: 'audio' }))).toBe('av');
    expect(mediaGroup(media({ local_path: 'a.mp4', kind: 'video' }))).toBe('av');
    expect(mediaGroup(media({ remote_url: 'https://x' }))).toBe('online');
  });

  it('asks for thumbnails only for local photos', () => {
    expect(hasThumbnail(media({ local_path: 'a.jpg' }))).toBe(true);
    expect(hasThumbnail(media({ remote_url: 'https://x' }))).toBe(false);
    expect(hasThumbnail(media({ local_path: 'a.pdf', kind: 'document' }))).toBe(false);
    expect(thumbUrl('My tree', 'M1', 'sm')).toBe('/api/trees/My%20tree/media/M1/thumb/sm');
  });
});
