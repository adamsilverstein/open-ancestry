import { describe, expect, it } from 'vitest';
import * as gedcom from './index';

describe('@open-ancestry/gedcom public API', () => {
  it('exports the parser, serializer and GEDZIP reader', () => {
    for (const name of [
      'parseGedcom',
      'parseGedcomStream',
      'serializeNode',
      'serializeGedcom',
      'readGedzip',
      'decodeGedcom',
      'analyzeHeader',
      'subtreeLines',
    ]) {
      expect(typeof (gedcom as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});
