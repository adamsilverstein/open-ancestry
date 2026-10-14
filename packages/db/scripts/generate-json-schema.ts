/**
 * Regenerates schema/oa-json.schema.json from the live database schema.
 *
 * Usage: npm run generate:json-schema -w @open-ancestry/db
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildJsonSchema, openMemoryTree } from '../src/index';

const store = openMemoryTree();
const file = join(import.meta.dirname, '..', 'schema', 'oa-json.schema.json');
writeFileSync(file, `${JSON.stringify(buildJsonSchema(store), null, 2)}\n`);
store.close();
console.log(`Wrote ${file}`);
