/**
 * Writes src/schemas.generated.json: the JSON Schema of every request schema
 * in src/schemas.source.ts. The server loads that JSON at runtime instead of
 * TypeBox, which costs ~60-80ms of startup (issue #54).
 *
 * Usage: npm run generate:schemas -w @open-ancestry/server
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSchemaJson } from '../src/schemas.build';

const target = fileURLToPath(new URL('../src/schemas.generated.json', import.meta.url));
writeFileSync(target, buildSchemaJson());
console.log(`wrote ${target}`);
