import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../components/Button/Button';
import { useToast } from '../../components/Toast/Toast';
import { cancelJob } from '../../library/api';

/**
 * Cancels a running or queued import (or reimport) job. The job's own state
 * then reports the outcome; this only asks the server and shows progress.
 */
export function CancelImportButton({ jobId, disabled }: { jobId: string; disabled?: boolean }) {
  const [cancelling, setCancelling] = useState(false);
  const toast = useToast();
  return (
    <Button
      variant="secondary"
      iconStart={<X size={16} aria-hidden />}
      loading={cancelling}
      disabled={disabled || cancelling}
      onClick={async () => {
        setCancelling(true);
        try {
          await cancelJob(jobId);
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
  );
}
