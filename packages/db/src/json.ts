import { BulkWriter } from './bulk';
import { ENUM_COLUMNS } from './enums';
import { LATEST_SCHEMA_VERSION, listTables } from './migrations/index';
import type { TreeStore } from './store';
import type { ChangeBatchRow, ChangeLogRow, TableRows } from './types';

/*
 * open-ancestry JSON interchange: a full-fidelity, canonical dump of every
 * table except derived search data. Canonical means tables in name order, rows
 * sorted by primary key, columns in schema order, two-space indentation and a
 * trailing newline, so export -> import -> export is byte-identical.
 */

export const OA_JSON_FORMAT = 'open-ancestry';
export const OA_JSON_FORMAT_VERSION = 1;

/** Derived tables rebuilt on import rather than exported. */
const DERIVED_TABLES = new Set(['search_doc', 'person_search']);
const HISTORY_TABLES = new Set(['change_batch', 'change_log']);

export type OaJsonTables = { [T in keyof TableRows]: TableRows[T][] } & {
  change_batch?: ChangeBatchRow[];
  change_log?: ChangeLogRow[];
};

export interface OaJsonDocument {
  format: typeof OA_JSON_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  tables: OaJsonTables;
}

export interface ExportOptions {
  /** Include change_batch and change_log (default true). */
  history?: boolean;
}

function exportedTables(store: TreeStore, history: boolean): string[] {
  return listTables(store.db)
    .filter((t) => !t.virtual && !DERIVED_TABLES.has(t.name))
    .filter((t) => history || !HISTORY_TABLES.has(t.name))
    .map((t) => t.name);
}

export function exportJson(
  store: TreeStore,
  { history = true }: ExportOptions = {},
): OaJsonDocument {
  const tables: Record<string, unknown[]> = {};
  for (const name of exportedTables(store, history)) {
    tables[name] = store.db.prepare(`SELECT * FROM ${name} ORDER BY ${store.plan(name).key}`).all();
  }
  return {
    format: OA_JSON_FORMAT,
    formatVersion: OA_JSON_FORMAT_VERSION,
    schemaVersion: LATEST_SCHEMA_VERSION,
    tables: tables as unknown as OaJsonTables,
  };
}

export function exportJsonString(store: TreeStore, options?: ExportOptions): string {
  return `${JSON.stringify(exportJson(store, options), null, 2)}\n`;
}

/**
 * Loads an exported document into an empty tree (a fresh `createTree`), in one
 * transaction, then rebuilds the search index. Meta keys other than
 * schema_version are replaced by the document's.
 */
export function importJson(store: TreeStore, doc: OaJsonDocument): void {
  if (doc.format !== OA_JSON_FORMAT || doc.formatVersion !== OA_JSON_FORMAT_VERSION) {
    throw new Error(`Unsupported format ${String(doc.format)} v${String(doc.formatVersion)}`);
  }
  if (doc.schemaVersion !== LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Document schema version ${doc.schemaVersion} does not match ${LATEST_SCHEMA_VERSION}`,
    );
  }
  const known = new Set(exportedTables(store, true));
  for (const name of Object.keys(doc.tables)) {
    if (!known.has(name)) throw new Error(`Unknown table ${name} in document`);
  }
  for (const name of known) {
    if (name === 'meta') continue;
    if (store.db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get()) {
      throw new Error('importJson needs an empty tree');
    }
  }
  const writer = new BulkWriter(store);
  try {
    store.db.exec("DELETE FROM meta WHERE key <> 'schema_version'");
    for (const [name, rows] of Object.entries(doc.tables) as unknown as [
      string,
      Record<string, unknown>[],
    ][]) {
      const columns = new Set(store.plan(name).columns);
      for (const row of rows) {
        if (name === 'meta' && row.key === 'schema_version') continue;
        const extra = Object.keys(row).find((c) => !columns.has(c));
        if (extra) throw new Error(`Unknown column ${name}.${extra} in document`);
        writer.insertAny(name, row);
      }
    }
  } catch (error) {
    writer.rollback();
    throw error;
  }
  writer.commit();
}

const JSON_TYPES: Record<string, string> = { TEXT: 'string', INTEGER: 'integer', REAL: 'number' };

/** JSON Schema (2020-12) for the interchange format, derived from the live schema. */
export function buildJsonSchema(store: TreeStore): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  const tableProps: Record<string, unknown> = {};
  const required: string[] = [];
  for (const name of exportedTables(store, true)) {
    const info = store.db
      .prepare('SELECT name, type, "notnull", pk FROM pragma_table_info(?)')
      .all(name) as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    const properties: Record<string, unknown> = {};
    for (const column of info) {
      const type = JSON_TYPES[column.type] as string;
      const values = (ENUM_COLUMNS as Record<string, readonly string[]>)[`${name}.${column.name}`];
      const nullable = !column.notnull && !column.pk;
      properties[column.name] = values
        ? { enum: [...values] }
        : { type: nullable ? [type, 'null'] : type };
    }
    defs[name] = {
      type: 'object',
      additionalProperties: false,
      required: info.map((c) => c.name),
      properties,
    };
    tableProps[name] = { type: 'array', items: { $ref: `#/$defs/${name}` } };
    if (!HISTORY_TABLES.has(name)) required.push(name);
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/adamsilverstein/open-ancestry/blob/main/packages/db/schema/oa-json.schema.json',
    title: 'open-ancestry JSON interchange',
    description:
      'Full-fidelity dump of an open-ancestry tree. Row shapes mirror the SQLite tables documented in docs/data-model.md.',
    type: 'object',
    additionalProperties: false,
    required: ['format', 'formatVersion', 'schemaVersion', 'tables'],
    properties: {
      format: { const: OA_JSON_FORMAT },
      formatVersion: { const: OA_JSON_FORMAT_VERSION },
      schemaVersion: { const: LATEST_SCHEMA_VERSION },
      tables: { type: 'object', additionalProperties: false, required, properties: tableProps },
    },
    $defs: defs,
  };
}
