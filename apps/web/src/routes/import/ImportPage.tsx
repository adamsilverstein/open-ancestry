import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import buttonStyles from '../../components/Button/Button.module.css';
import { cx } from '../../lib/cx';
import { setCurrentTree, treesQuery, type ImportProgress } from '../../library/api';
import { finished, useImportJob } from '../../library/useImportJob';
import { useToast } from '../../components/Toast/Toast';
import { CancelImportButton } from './CancelImportButton';
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

/** Moves focus to an element when it appears (the Cancel button it replaced is gone). */
const focusOnMount = (element: HTMLElement | null) => element?.focus();

export function ImportPage() {
  const { jobId } = useParams({ from: '/import/$jobId' });
  const { job, missing } = useImportJob(jobId);
  const queryClient = useQueryClient();
  const toast = useToast();
  const settled = useRef(false);
  const [cancelAccepted, setCancelAccepted] = useState(false);

  useEffect(() => {
    if (!job || !finished(job) || settled.current) return;
    settled.current = true;
    if (job.cancelled) {
      toast({
        title: 'Import cancelled',
        description: job.createdTree
          ? `The partial tree for ${job.fileName} was removed.`
          : `Nothing was imported from ${job.fileName}.`,
      });
    }
    // Display only: a failed import's tree is the server's to clean up.
    if (job.state === 'completed') void setCurrentTree(queryClient, job.tree);
    else void queryClient.invalidateQueries({ queryKey: treesQuery.queryKey });
  }, [job, queryClient, toast]);

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
    // A cancel the server took as the import reached saving: it finished anyway.
    return (
      <ImportReport
        job={job}
        report={job.result}
        note={cancelAccepted ? 'Too late to cancel; the import finished.' : undefined}
      />
    );
  }

  if (job?.state === 'failed' && job.cancelled) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title} ref={focusOnMount} tabIndex={-1}>
          Import cancelled
        </h1>
        <p className={styles.note}>
          Nothing was imported from {job.fileName}.
          {job.createdTree && ' The tree made for it was removed, and the uploaded file deleted.'}
        </p>
        <Link to="/" className={cx(buttonStyles.button, buttonStyles.secondary, buttonStyles.md)}>
          Import a file
        </Link>
      </div>
    );
  }

  if (job?.state === 'failed') {
    return (
      <div className={styles.page}>
        <h1 className={styles.title} ref={focusOnMount} tabIndex={-1}>
          Import failed
        </h1>
        <p role="alert" className={styles.error}>
          {job.error ?? 'The import stopped with an unknown error.'}
        </p>
        <p className={styles.note}>
          Nothing was imported from {job.fileName}.
          {job.createdTree && ' The empty tree made for it was removed.'}
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
      {job && !finished(job) && (
        <div className={styles.actions}>
          <CancelImportButton job={job} onCancelAccepted={() => setCancelAccepted(true)} />
        </div>
      )}
    </div>
  );
}
