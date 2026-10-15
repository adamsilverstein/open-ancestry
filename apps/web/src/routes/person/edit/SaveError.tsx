import { useEffect, useRef, useState } from 'react';
import { CircleAlert, RotateCw } from 'lucide-react';
import { isStale } from '../../../api/client';
import { Button } from '../../../components/Button/Button';
import styles from './Edit.module.css';

/**
 * State for a form that stays open until its save succeeds: the error to
 * show, and handlers to pass to `edit.mutate` as `onDone` and `onError`.
 */
export function useSaveState(onSaved: () => void) {
  const [error, setError] = useState<string | null>(null);
  // Refused as made from old data (409 stale): saving again cannot help, reloading can.
  const [stale, setStale] = useState(false);
  // A save that finishes after its form closed (Cancel) must not act on a newer one.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return {
    error,
    stale,
    /** Clears a stale error, e.g. when another form opens. */
    reset: () => {
      setError(null);
      setStale(false);
    },
    /** Label for the submit button: after a failure it says what pressing it does. */
    submitLabel: (label: string) => (error && !stale ? 'Try again' : label),
    handlers: () => {
      setError(null);
      setStale(false);
      return {
        onDone: () => {
          if (mounted.current) onSaved();
        },
        onError: (cause: unknown) => {
          if (!mounted.current) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          setStale(isStale(cause));
        },
      };
    },
  };
}

/**
 * Why the last save failed; the form keeps what was typed so it can be saved
 * again. A stale refusal offers `onReload` instead of a retry that would fail.
 */
export function SaveError({
  error,
  stale = false,
  onReload,
}: {
  error: string | null;
  stale?: boolean;
  onReload?: () => void;
}) {
  if (!error) return null;
  if (stale && onReload) {
    return (
      <div role="alert" className={styles.error}>
        <CircleAlert size={14} aria-hidden />
        <span>
          This changed in another window (or by undo) after you opened the form, so nothing was
          saved. Reload the form to see the latest; your changes are kept.
        </span>
        <Button size="sm" iconStart={<RotateCw size={14} aria-hidden />} onClick={onReload}>
          Reload form
        </Button>
      </div>
    );
  }
  return (
    <p role="alert" className={styles.error}>
      <CircleAlert size={14} aria-hidden />
      Could not save: {error.replace(/\.+$/, '')}. Your changes are still here.
    </p>
  );
}
