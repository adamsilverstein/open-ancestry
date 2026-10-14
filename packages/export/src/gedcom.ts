import type { TreeStore } from '@open-ancestry/db';
import type { GedcomExport, GedcomExportOptions } from './types';

export function buildGedcomExport(
  _store: TreeStore,
  _options: GedcomExportOptions = {},
): GedcomExport {
  throw new Error('not implemented');
}

export function exportGedcom(store: TreeStore, options: GedcomExportOptions = {}): string {
  return buildGedcomExport(store, options).text;
}
