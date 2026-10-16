/*
 * Unicode normalization. The same text can arrive composed (NFC, typed on most
 * systems) or decomposed (NFD: macOS file names, text pasted from PDFs, some
 * merged trees). Stored text is NFC so equal-looking names, places and tags
 * compare equal. Columns that must stay byte-exact are left alone.
 */

/**
 * Tables kept verbatim: original GEDCOM text, import bookkeeping, change
 * history (its images are upgraded per migration instead) and derived state.
 */
const VERBATIM_TABLES = new Set([
  'raw_record',
  'unmapped_line',
  'import_batch',
  'change_batch',
  'change_log',
  'derived_state',
  'search_doc',
  'person_search',
  'person_sort',
]);

/** Columns that name things outside the database (files, URLs) or are machine values. */
const VERBATIM_COLUMNS: Record<string, ReadonlySet<string>> = {
  media: new Set(['local_path', 'remote_url', 'sha256', 'mime']),
  // Links point at files or pages whose bytes matter (a macOS server may serve
  // a decomposed path), so they are kept exactly as given, like remote_url.
  citation: new Set(['url']),
  repository: new Set(['url']),
};

/**
 * meta key listing (as a JSON array) the place and tag ids the NFC upgrade
 * merged away. Older change_log images may still name them; undo uses this to
 * explain why such an edit cannot be undone.
 */
export const MERGED_IDS_KEY = 'nfc_merged_ids';

const NON_ASCII = /[\u0080-\uffff]/;

/** NFC form of `text`; ASCII (most text) is returned without calling into ICU. */
export function toNFC(text: string): string {
  return NON_ASCII.test(text) ? text.normalize('NFC') : text;
}

/** Whether a column holds human text that is stored NFC. */
export function isNfcColumn(table: string, column: string): boolean {
  if (VERBATIM_TABLES.has(table) || VERBATIM_COLUMNS[table]?.has(column)) return false;
  return (
    column !== 'id' &&
    column !== 'external_id' &&
    !column.endsWith('_id') &&
    !column.endsWith('_at') &&
    column !== 'key'
  );
}

/** `row` with its human-text string values in NFC (a copy only when something changes). */
export function nfcRow<T extends Record<string, unknown>>(table: string, row: T): T {
  if (VERBATIM_TABLES.has(table)) return row;
  let out: Record<string, unknown> | undefined;
  for (const column in row) {
    const value = row[column];
    if (typeof value !== 'string' || !isNfcColumn(table, column)) continue;
    const nfc = toNFC(value);
    if (nfc !== value) (out ??= { ...row })[column] = nfc;
  }
  return (out ?? row) as T;
}
