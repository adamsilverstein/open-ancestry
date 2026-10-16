import { describe, expect, it } from 'vitest';
import { canPrivatize, downloadName, exportUrl, exportWarnings } from './exportUrl';

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

  it('leaves the edit history out of JSON unless asked for', () => {
    // The API leaves it out by default too, so only asking for it adds a parameter.
    expect(exportUrl('Vale', 'json', false, false)).toBe('/api/trees/Vale/export.json');
    expect(exportUrl('Vale', 'json', false)).toBe('/api/trees/Vale/export.json');
    expect(exportUrl('Vale', 'json', false, true)).toBe('/api/trees/Vale/export.json?history=1');
    // GEDCOM has no history to leave out.
    expect(exportUrl('Vale', 'gedcom-7', false, false)).toBe(
      '/api/trees/Vale/export.ged?version=7',
    );
  });

  it('never privatizes JSON, which always includes everyone', () => {
    expect(canPrivatize('json')).toBe(false);
    expect(exportUrl('Vale', 'json', true)).toBe('/api/trees/Vale/export.json');
  });
});

describe('downloadName', () => {
  it('prefers the UTF-8 name, then the ASCII one, then the fallback', () => {
    expect(
      downloadName(`attachment; filename="Vale _.ged"; filename*=UTF-8''Vale%20%C3%BC.ged`, 'x'),
    ).toBe('Vale ü.ged');
    expect(downloadName('attachment; filename="Vale.ged"', 'x')).toBe('Vale.ged');
    expect(downloadName(`attachment; filename*=UTF-8''%E0%A4%A.ged`, 'x')).toBe('x');
    expect(downloadName(null, 'Tree.ged')).toBe('Tree.ged');
  });
});

describe('exportWarnings', () => {
  it('reads the count and the warnings sent', () => {
    const headers = new Headers({
      'x-oa-export-warning-count': '25',
      'x-oa-export-warnings': encodeURIComponent(JSON.stringify(['@I1@: lost'])),
    });
    expect(exportWarnings(headers)).toEqual({ count: 25, shown: ['@I1@: lost'] });
    expect(exportWarnings(new Headers())).toEqual({ count: 0, shown: [] });
    expect(exportWarnings(new Headers({ 'x-oa-export-warnings': '%7Bbad' }))).toEqual({
      count: 0,
      shown: [],
    });
  });
});
