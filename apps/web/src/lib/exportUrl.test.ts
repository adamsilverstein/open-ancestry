import { describe, expect, it } from 'vitest';
import { canPrivatize, exportUrl } from './exportUrl';

describe('exportUrl', () => {
  it('builds the download URL for each format', () => {
    expect(exportUrl('Vale', 'gedcom-5.5.1', false)).toBe('/api/trees/Vale/export.ged');
    expect(exportUrl('Vale', 'gedcom-7', false)).toBe('/api/trees/Vale/export.ged?version=7');
    expect(exportUrl('Vale', 'gedzip', true)).toBe('/api/trees/Vale/export.gdz?privatize=true');
    expect(exportUrl('Vale', 'json', false)).toBe('/api/trees/Vale/export.json');
  });

  it('encodes the tree name and combines version and privatize', () => {
    expect(exportUrl('Vale & Reed', 'gedcom-7', true)).toBe(
      '/api/trees/Vale%20%26%20Reed/export.ged?version=7&privatize=true',
    );
  });

  it('never privatizes JSON, which is a full backup', () => {
    expect(canPrivatize('json')).toBe(false);
    expect(exportUrl('Vale', 'json', true)).toBe('/api/trees/Vale/export.json');
  });
});
