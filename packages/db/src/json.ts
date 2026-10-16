import { createRequire } from 'node:module';
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import Database from 'better-sqlite3';
import { BulkWriter } from './bulk';
import { refreshDerivedColumns } from './derived';
import { ENUM_COLUMNS } from './enums';
import { listTables, migrate, upgradeRow, type TableRowsByName } from './migrations/index';
import { nfcRow } from './nfc';
import type { TreeStore } from './store';
import { parseLogImage } from './undo';
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
const DERIVED_TABLES = new Set(['search_doc', 'person_search', 'derived_state', 'person_sort']);
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
  /**
   * Include change_batch and change_log (default true). Without them, import
   * warnings (which can quote imported lines) are left out too.
   */
  history?: boolean;
  /**
   * Records (`owner_type|owner_id`) whose raw_record and unmapped_line rows are
   * left out: the imported text of records changed or deleted since import,
   * which still holds what was edited away (see changedSinceImport in
   * @open-ancestry/export).
   */
  omitImportedText?: ReadonlySet<string>;
}

/**
 * An import batch without the imported lines it quotes: warnings, and the
 * example line of each unmapped tag in its counts.
 */
function withoutImportedLines(row: Record<string, unknown>): Record<string, unknown> {
  let counts = row.counts_json;
  try {
    const parsed = JSON.parse(String(counts)) as { unmapped?: { example?: unknown }[] };
    for (const u of parsed.unmapped ?? []) delete u.example;
    counts = JSON.stringify(parsed);
  } catch {
    counts = '{}';
  }
  return { ...row, warnings_json: '[]', counts_json: counts };
}

/** Tables holding a record's imported GEDCOM text, by owner. */
const IMPORTED_TEXT_TABLES = new Set(['raw_record', 'unmapped_line']);

function exportedTables(store: TreeStore, history: boolean): string[] {
  return listTables(store.db)
    .filter((t) => !t.virtual && !DERIVED_TABLES.has(t.name))
    .filter((t) => history || !HISTORY_TABLES.has(t.name))
    .map((t) => t.name);
}

export function exportJson(
  store: TreeStore,
  { history = true, omitImportedText }: ExportOptions = {},
): OaJsonDocument {
  const tables: Record<string, unknown[]> = {};
  for (const name of exportedTables(store, history)) {
    let rows = store.db
      .prepare(`SELECT * FROM ${name} ORDER BY ${store.plan(name).key}`)
      .all() as Record<string, unknown>[];
    if (omitImportedText?.size && IMPORTED_TEXT_TABLES.has(name)) {
      rows = rows.filter(
        (r) =>
          r.owner_id == null ||
          !omitImportedText.has(`${String(r.owner_type)}|${String(r.owner_id)}`),
      );
    }
    if (!history && name === 'import_batch') rows = rows.map(withoutImportedLines);
    tables[name] = rows;
  }
  return {
    format: OA_JSON_FORMAT,
    formatVersion: OA_JSON_FORMAT_VERSION,
    schemaVersion: store.schemaVersion,
    tables: tables as unknown as OaJsonTables,
  };
}

export function exportJsonString(store: TreeStore, options?: ExportOptions): string {
  return `${JSON.stringify(exportJson(store, options), null, 2)}\n`;
}

export interface ImportOptions {
  /** Refuse documents with more rows than this across all tables (default 5,000,000). */
  maxRows?: number;
}

export interface ImportStringOptions extends ImportOptions {
  /** Refuse input larger than this many UTF-8 bytes before parsing (default 512 MiB). */
  maxBytes?: number;
}

const validators = new WeakMap<TreeStore, ValidateFunction>();

/**
 * Ajv is only needed to import a JSON document, so it loads on first use
 * rather than with every process that opens a tree (server cold start, #54).
 */
let Ajv2020: typeof Ajv2020Class | undefined;
function loadAjv(): typeof Ajv2020Class {
  Ajv2020 ??= (
    createRequire(import.meta.url)('ajv/dist/2020.js') as { Ajv2020: typeof Ajv2020Class }
  ).Ajv2020;
  return Ajv2020;
}

function validator(store: TreeStore): ValidateFunction {
  let validate = validators.get(store);
  if (!validate) {
    validate = new (loadAjv())({ allErrors: false, allowUnionTypes: true }).compile(
      buildJsonSchema(store),
    );
    validators.set(store, validate);
  }
  return validate;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Loads an exported document into an empty tree (a fresh `createTree`).
 * Documents from an older schema version are upgraded through the migration
 * chain first; newer ones are refused.
 *
 * The document is untrusted. Before anything is written it must pass the
 * envelope checks, the row cap and the published JSON Schema (exact columns,
 * types and enums for every row), and every change_log image is checked like
 * undo checks it. Table and column names used in SQL come only from the live
 * schema, never from the document; values are bound parameters. Everything is
 * then written in one transaction (foreign keys and CHECKs enforced at commit)
 * that rolls back on any error, and the search index is rebuilt.
 */
export function importJson(
  store: TreeStore,
  input: unknown,
  { maxRows = 5_000_000 }: ImportOptions = {},
): void {
  if (!isObject(input)) throw new Error('Document must be a JSON object');
  let doc = input as Partial<OaJsonDocument>;
  if (doc.format !== OA_JSON_FORMAT || doc.formatVersion !== OA_JSON_FORMAT_VERSION) {
    throw new Error(`Unsupported format ${String(doc.format)} v${String(doc.formatVersion)}`);
  }
  const version = doc.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error(`Unsupported document schema version ${String(version)}`);
  }
  if (version > store.schemaVersion) {
    throw new Error(
      `Document schema version ${version} is newer than this tree supports (${store.schemaVersion}); upgrade open-ancestry.`,
    );
  }
  if (!isObject(doc.tables)) throw new Error('Document tables must be an object');
  // Table names come from the document: keep them off Object.prototype.
  let tables: TableRowsByName = Object.create(null) as TableRowsByName;
  let rowCount = 0;
  for (const [name, rows] of Object.entries(doc.tables)) {
    if (name === '__proto__') throw new Error(`Unknown table ${JSON.stringify(name)} in document`);
    if (!Array.isArray(rows)) throw new Error(`Table ${name} must be an array`);
    rowCount += rows.length;
    if (rowCount > maxRows) throw new Error(`Document has more than the ${maxRows} row limit`);
    if (!rows.every(isObject)) throw new Error(`Table ${name} rows must be objects`);
    tables[name] = rows as unknown as Record<string, unknown>[];
  }
  const known = exportedTables(store, true);
  if (version < store.schemaVersion) {
    tables = upgradeTables(store, version, tables);
    // A table added by a later migration has no rows in an older backup.
    const existed = tablesAtVersion(store, version);
    for (const name of known) {
      if (!HISTORY_TABLES.has(name) && !existed.has(name)) tables[name] ??= [];
    }
  }
  const knownSet = new Set(known);
  for (const name of Object.keys(tables)) {
    if (!knownSet.has(name)) throw new Error(`Unknown table ${JSON.stringify(name)} in document`);
  }
  doc = { ...doc, schemaVersion: store.schemaVersion, tables: tables as unknown as OaJsonTables };

  const validate = validator(store);
  if (!validate(doc)) {
    const [first] = validate.errors ?? [];
    throw new Error(
      `Document does not match the JSON Schema: ${first?.instancePath ?? ''} ${first?.message ?? ''}`.trim(),
    );
  }
  const valid = doc as OaJsonDocument;
  for (const entry of valid.tables.change_log ?? []) {
    parseLogImage(store, entry.entity, entry.entity_id, entry.before_json, entry.schema_version);
    parseLogImage(store, entry.entity, entry.entity_id, entry.after_json, entry.schema_version);
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
    // Iterate the live schema's tables, not the document's keys.
    for (const name of known) {
      const rows =
        (valid.tables as unknown as Record<string, Record<string, unknown>[] | undefined>)[name] ??
        [];
      for (const row of rows) {
        if (name === 'meta' && row.key === 'schema_version') continue;
        // Text is stored as NFC (#164). An old document got that from the v3
        // upgrade step; a current one written by another tool may still be NFD.
        // History images are normalized too, or undo would see the NFC rows as
        // changed by a later edit.
        writer.insertAny(name, name === 'change_log' ? nfcLogImages(row) : nfcRow(name, row));
      }
    }
  } catch (error) {
    writer.rollback();
    throw error;
  }
  writer.commit();
  // The backup's sort keys came from whatever date parser wrote them.
  refreshDerivedColumns(store, { force: true, reason: 'imported backup' });
}

/** A change_log row with its before and after images in NFC (a copy only when something changes). */
function nfcLogImages(row: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const column of ['before_json', 'after_json']) {
    const json = row[column];
    if (typeof json !== 'string') continue;
    const image = JSON.parse(json) as Record<string, unknown>;
    const nfc = nfcRow(String(row.entity), image);
    if (nfc !== image) (out ??= { ...row })[column] = JSON.stringify(nfc);
  }
  return out ?? row;
}

/**
 * Upgrades an older document's rows through each later migration in turn:
 * its column map and `upgradeRow`, then any whole-document step. Rows are copied, not changed
 * in place. change_log images keep their own version; undo upgrades them.
 */
function upgradeTables(store: TreeStore, from: number, input: TableRowsByName): TableRowsByName {
  const tables: TableRowsByName = Object.create(null) as TableRowsByName;
  for (const [name, rows] of Object.entries(input)) tables[name] = rows.map((row) => ({ ...row }));
  for (const migration of store.migrations) {
    if (migration.version <= from) continue;
    for (const [name, rows] of Object.entries(tables)) {
      if (migration.upgradeRow || migration.columns?.[name]) {
        tables[name] = rows.map((row) => upgradeRow([migration], from, name, row));
      }
    }
    migration.upgradeTables?.(tables);
  }
  return tables;
}

/** Tables the schema had at `version`, from an in-memory database migrated that far. */
function tablesAtVersion(store: TreeStore, version: number): Set<string> {
  const db = new Database(':memory:');
  try {
    migrate(db, { migrations: store.migrations, to: version });
    return new Set(listTables(db).map((t) => t.name));
  } finally {
    db.close();
  }
}

/** Parses and imports a JSON document, refusing oversized input before parsing. */
export function importJsonString(
  store: TreeStore,
  text: string,
  { maxBytes = 512 * 1024 * 1024, ...options }: ImportStringOptions = {},
): void {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes)
    throw new Error(`Document is ${bytes} bytes, more than the ${maxBytes} limit`);
  importJson(store, JSON.parse(text) as unknown, options);
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
      schemaVersion: { const: store.schemaVersion },
      tables: { type: 'object', additionalProperties: false, required, properties: tableProps },
    },
    $defs: defs,
  };
}
