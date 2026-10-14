import type { ImportInput, ImportOptions, ImportReport, ImportTarget } from './types';
import { ImportError } from './types';

export async function importGedcom(
  input: ImportInput,
  target: ImportTarget,
  options: ImportOptions = {},
): Promise<ImportReport> {
  void input;
  void target;
  void options;
  throw new ImportError('read-failed', 'not implemented');
}
