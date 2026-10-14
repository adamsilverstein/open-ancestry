import { useEffect, useState } from 'react';
import { getJob, jobEventsUrl, type ImportJob, type ImportProgress } from './api';

export const finished = (job: ImportJob | null) =>
  job?.state === 'completed' || job?.state === 'failed';

/** Follows an import (or re-import) job over server-sent events. */
export function useImportJob(jobId: string) {
  const [job, setJob] = useState<ImportJob | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      source = new EventSource(jobEventsUrl(jobId));
      source.addEventListener('state', (event) => setJob(JSON.parse(event.data) as ImportJob));
      source.addEventListener('progress', (event) => {
        const progress = JSON.parse(event.data) as ImportProgress;
        setJob((current) => (current ? { ...current, progress } : current));
      });
      // The stream ends when the job does, which also lands here: read the final state.
      source.onerror = () => {
        source?.close();
        getJob(jobId)
          .then((latest) => {
            if (closed) return;
            setJob(latest);
            if (!finished(latest)) retry = setTimeout(connect, 1000);
          })
          .catch(() => !closed && setMissing(true));
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
      clearTimeout(retry);
    };
  }, [jobId]);

  return { job, missing };
}
