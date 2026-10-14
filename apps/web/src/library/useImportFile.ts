import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { BAD_FILE_MESSAGE, hasImportExtension, importIntoNewTree } from './api';

/** Validates a chosen file, starts its import into a new tree and opens the progress page. */
export function useImportFile() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function importFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    if (!hasImportExtension(file.name)) {
      setError(BAD_FILE_MESSAGE);
      return;
    }
    setBusy(true);
    try {
      const { jobId } = await importIntoNewTree(file);
      await navigate({ to: '/import/$jobId', params: { jobId } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The import could not start');
    } finally {
      setBusy(false);
    }
  }

  return { importFile, error, busy };
}
