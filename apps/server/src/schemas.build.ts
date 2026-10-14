import * as source from './schemas.source';

/** The request schemas as canonical JSON (what schemas.generated.json must contain). */
export function buildSchemaJson(): string {
  const schemas = Object.fromEntries(
    Object.entries(source)
      .filter(([, value]) => typeof value === 'object' && value !== null)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return `${JSON.stringify(schemas, null, 2)}\n`;
}
