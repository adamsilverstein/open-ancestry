import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../components/Button/Button';
import { useToast } from '../../components/Toast/Toast';
import { cancelJob, type ImportJob } from '../../library/api';
import styles from './Import.module.css';

/**
 * Phases an import can be stopped in: imports run in a worker thread the
 * server can terminate while reading, parsing or mapping. Finalize and
 * commit are past the point of no return.
 */
const CANCELLABLE_PHASES: ReadonlySet<string> = new Set(['read', 'parse', 'map']);

/** Whether a cancel could stop `job` right now. */
export function canCancel(job: Pick<ImportJob, 'state' | 'progress'>): boolean {
  if (job.state === 'queued') return true;
  return job.state === 'running' && CANCELLABLE_PHASES.has(job.progress?.phase ?? 'read');
}

/**
 * Cancels a running or queued import (or reimport) job. The job's own state
 * then reports the outcome; this only asks the server and shows progress.
 */
export function CancelImportButton({ job }: { job: Pick<ImportJob, 'id' | 'state' | 'progress'> }) {
  const [cancelling, setCancelling] = useState(false);
  const toast = useToast();
  const hintId = useId();
  const enabled = canCancel(job);
  const hint = enabled ? undefined : 'Saving the tree; this can no longer be cancelled.';
  return (
    <>
      <Button
        variant="secondary"
        iconStart={<X size={16} aria-hidden />}
        loading={cancelling}
        disabled={!enabled || cancelling}
        aria-describedby={hint ? hintId : undefined}
        onClick={async () => {
          setCancelling(true);
          try {
            if (!(await cancelJob(job.id))) {
              setCancelling(false);
              toast({ title: 'Too late to cancel', description: 'The import is finishing.' });
            }
          } catch (error) {
            setCancelling(false);
            toast({
              title: 'Could not cancel the import',
              description: error instanceof Error ? error.message : String(error),
              variant: 'error',
            });
          }
        }}
      >
        {cancelling ? 'Cancelling…' : 'Cancel import'}
      </Button>
      {hint && (
        <p id={hintId} className={styles.note}>
          {hint}
        </p>
      )}
    </>
  );
}
