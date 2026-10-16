import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { Hourglass, RefreshCw, TriangleAlert } from 'lucide-react';
import { isBusy } from '../api/client';
import { Button } from '../components/Button/Button';
import { EmptyState } from '../components/EmptyState/EmptyState';
import { isChunkLoadError } from '../lib/chunkError';
import styles from './Page.module.css';

/**
 * Shown in place of a page that failed. A page whose code will not load
 * (usually a new build after a server restart) gets a reload; anything else
 * gets a retry. The top bar stays usable either way.
 */
export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  if (isChunkLoadError(error)) {
    return (
      <div className={styles.centered}>
        <EmptyState
          level={1}
          icon={<RefreshCw size={28} aria-hidden />}
          title="A new version of open-ancestry is ready"
          description="This page could not load. Reload to get the latest version; your trees are safe."
          action={
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        />
      </div>
    );
  }
  // A tree another process is importing or upgrading: nothing is broken, it just needs a moment.
  const busy = isBusy(error);
  return (
    <div className={styles.centered}>
      <EmptyState
        level={1}
        icon={busy ? <Hourglass size={28} aria-hidden /> : <TriangleAlert size={28} aria-hidden />}
        title={busy ? 'This tree is busy' : 'Something went wrong'}
        description={error instanceof Error ? error.message : String(error)}
        action={
          <Button
            onClick={() => {
              reset();
              void router.invalidate();
            }}
          >
            Try again
          </Button>
        }
      />
    </div>
  );
}
