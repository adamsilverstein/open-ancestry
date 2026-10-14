import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSchemaJson } from './schemas.build';
import * as schemas from './schemas';

describe('generated request schemas', () => {
  it('match schemas.source.ts (run npm run generate:schemas after editing it)', () => {
    const file = readFileSync(new URL('./schemas.generated.json', import.meta.url), 'utf8');
    expect(JSON.parse(file)).toEqual(JSON.parse(buildSchemaJson()));
  });

  it('export every schema as plain JSON', () => {
    expect(schemas.TreeParams).toEqual({
      type: 'object',
      required: ['tree'],
      properties: { tree: { type: 'string', minLength: 1, maxLength: 100 } },
    });
    expect(Object.keys(schemas).length).toBeGreaterThan(30);
  });
});
