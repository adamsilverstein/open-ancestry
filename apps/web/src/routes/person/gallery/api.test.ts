import type { MediaRow } from '@open-ancestry/db';
import { describe, expect, it } from 'vitest';
import { ancestryLink, hasThumbnail, mediaGroup, thumbUrl } from './api';

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

describe('ancestryLink', () => {
  it('allows only https links to Ancestry hosts', () => {
    expect(ancestryLink('https://www.ancestry.com/mediaui-viewer/collection/1/tree/2')).toBe(
      'https://www.ancestry.com/mediaui-viewer/collection/1/tree/2',
    );
    expect(ancestryLink('https://mediasvc.ancestry.com/v2/image/x.jpg')).toBeTruthy();
    expect(ancestryLink('https://www.ancestry.co.uk/a')).toBeTruthy();
    expect(ancestryLink('https://www.ancestry.com.au/a')).toBeTruthy();
    expect(ancestryLink('https://media.ancestrycdn.com/a.jpg')).toBeTruthy();
    for (const hostile of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'http://www.ancestry.com/a',
      'https://evil.example/ancestry.com',
      'https://ancestry.com.evil.example/a',
      'https://notancestry.com/a',
      'https://user:pass@www.ancestry.com/a',
      'not a url',
      '',
      null,
    ]) {
      expect(ancestryLink(hostile)).toBeNull();
    }
  });
});
