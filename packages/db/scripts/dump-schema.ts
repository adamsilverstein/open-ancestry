/**
 * Writes the frozen schema dump for the latest migration to
 * src/migrations/history/schema-vN.sql. Run once when adding a migration;
 * released dumps must never change.
 *
 * Usage: npm run dump-schema -w @open-ancestry/db
 */
import Database from 'better-sqlite3';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LATEST_SCHEMA_VERSION, dumpSchema, migrate } from '../src/index';

const file = join(
  import.meta.dirname,
  '..',
  'src',
  'migrations',
  'history',
  `schema-v${LATEST_SCHEMA_VERSION}.sql`,
);
if (existsSync(file)) {
  console.error(`${file} already exists; released schema dumps are frozen.`);
  process.exit(1);
}
const db = new Database(':memory:');
migrate(db);
writeFileSync(file, `${dumpSchema(db)}\n`);
console.log(`Wrote ${file}`);
