import type { TableName } from './types';

/**
 * Tables the unit of work, bulk loader and undo may write, parents first.
 * Every SQL statement built from a table name checks it against these lists.
 */
export const DATA_TABLES: readonly TableName[] = [
  'meta',
  'import_batch',
  'media',
  'person',
  'person_name',
  'place',
  'event',
  'family',
  'family_child',
  'event_role',
  'repository',
  'source',
  'citation',
  'citation_link',
  'media_link',
  'note',
  'note_link',
  'tag',
  'tag_link',
  'raw_record',
  'unmapped_line',
];

/** Change history tables, written only by the unit of work itself and the JSON importer. */
export const HISTORY_TABLES: readonly string[] = ['change_batch', 'change_log'];

const DATA_SET = new Set<string>(DATA_TABLES);

export function isDataTable(table: string): table is TableName {
  return DATA_SET.has(table);
}

export function assertDataTable(table: string): asserts table is TableName {
  if (!DATA_SET.has(table))
    throw new Error(`Writes to table ${JSON.stringify(table)} are not allowed`);
}
