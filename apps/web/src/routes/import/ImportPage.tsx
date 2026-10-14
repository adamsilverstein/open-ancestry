import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import buttonStyles from '../../components/Button/Button.module.css';
import { cx } from '../../lib/cx';
import {
  deleteTree,
  getJob,
  jobEventsUrl,
  setCurrentTree,
  treesQuery,
  type ImportJob,
  type ImportProgress,
} from '../../library/api';
import { ImportReport } from './ImportReport';
import styles from './Import.module.css';

const PHASES: Record<ImportProgress['phase'], string> = {
  read: 'Reading the file',
  parse: 'Parsing GEDCOM',
  map: 'Mapping records',
  finalize: 'Linking families and checking the tree',
  commit: 'Saving and building the search index',
  done: 'Finishing',
};

const finished = (job: ImportJob | null) => job?.state === 'completed' || job?.state === 'failed';

/** Follows an import job over server-sent events and shows its report. */
function useImportJob(jobId: string) {
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

export function ImportPage() {
  const { jobId } = useParams({ from: '/import/$jobId' });
  const { job, missing } = useImportJob(jobId);
  const queryClient = useQueryClient();
  const settled = useRef(false);

  useEffect(() => {
    if (!job || !finished(job) || settled.current) return;
    settled.current = true;
    if (job.state === 'completed') void setCurrentTree(queryClient, job.tree);
    // A failed import leaves an empty tree behind; it was created only for this file.
    else
      void deleteTree(job.tree)
        .catch(() => {})
        .then(() => queryClient.invalidateQueries({ queryKey: treesQuery.queryKey }));
  }, [job, queryClient]);

  if (missing) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Import not found</h1>
        <p className={styles.note}>
          The server no longer knows this import; it may have restarted. Your trees are listed on
          the home page.
        </p>
        <Link to="/" className={cx(buttonStyles.button, buttonStyles.secondary, buttonStyles.md)}>
          Back to import
        </Link>
      </div>
    );
  }

  if (job?.state === 'completed' && job.result) {
    return <ImportReport job={job} report={job.result} />;
  }

  if (job?.state === 'failed') {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Import failed</h1>
        <p role="alert" className={styles.error}>
          {job.error ?? 'The import stopped with an unknown error.'}
        </p>
        <p className={styles.note}>
          Nothing was imported from {job.fileName}; the empty tree made for it was removed.
        </p>
        <Link to="/" className={cx(buttonStyles.button, buttonStyles.secondary, buttonStyles.md)}>
          Try another file
        </Link>
      </div>
    );
  }

  const progress = job?.progress;
  const fraction =
    progress?.phase === 'map' && progress.total > 0 ? progress.done / progress.total : undefined;
  return (
    <div className={styles.page} aria-busy="true">
      <h1 className={styles.title}>{job ? `Importing ${job.fileName}` : 'Starting the import'}</h1>
      <progress
        className={styles.progress}
        aria-label="Import progress"
        {...(fraction !== undefined && { value: fraction, max: 1 })}
      />
      <p className={styles.note} aria-live="polite">
        {job?.state === 'queued'
          ? 'Waiting for another import to finish'
          : progress
            ? `${PHASES[progress.phase]}${progress.phase === 'map' ? ` (${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} records)` : ''}`
            : 'Uploading'}
      </p>
    </div>
  );
}
