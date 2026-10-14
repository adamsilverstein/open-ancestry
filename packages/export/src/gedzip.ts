import type { TreeStore } from '@open-ancestry/db';
import type { GedzipExport, GedzipExportOptions } from './types';

export function buildGedzipExport(
  _store: TreeStore,
  _options: GedzipExportOptions = {},
): GedzipExport {
  throw new Error('not implemented');
}

export function exportGedzip(store: TreeStore, options: GedzipExportOptions = {}): Uint8Array {
  return buildGedzipExport(store, options).bytes;
}
