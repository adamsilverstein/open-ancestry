export type ExportFormat = 'gedcom-5.5.1' | 'gedcom-7' | 'gedzip' | 'json';

export const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'gedcom-5.5.1', label: 'GEDCOM 5.5.1 (Ancestry)' },
  { value: 'gedcom-7', label: 'GEDCOM 7' },
  { value: 'gedzip', label: 'GEDZIP (GEDCOM 7 with media)' },
  { value: 'json', label: 'JSON (full backup)' },
];

/** Whether a format can leave out living people (JSON is a full backup, so it cannot). */
export const canPrivatize = (format: ExportFormat) => format !== 'json';

/** Download URL of a tree export (see docs/api.md). */
export function exportUrl(tree: string, format: ExportFormat, privatize: boolean): string {
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  const query = new URLSearchParams();
  if (format === 'gedcom-7') query.set('version', '7');
  if (privatize && canPrivatize(format)) query.set('privatize', 'true');
  const path =
    format === 'json' ? 'export.json' : format === 'gedzip' ? 'export.gdz' : 'export.ged';
  const search = query.toString();
  return `${base}/${path}${search ? `?${search}` : ''}`;
}
