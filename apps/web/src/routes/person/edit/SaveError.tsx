import { useEffect, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { isNotFound } from '../../../api/client';
import styles from './Edit.module.css';

/**
 * State for a form that stays open until its save succeeds: the error to
 * show, and handlers to pass to `edit.mutate` as `onDone` and `onError`.
 */
export function useSaveState(onSaved: () => void) {
  const [error, setError] = useState<string | null>(null);
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
    /** Clears a stale error, e.g. when another form opens. */
    reset: () => setError(null),
    /** Label for the submit button: after a failure it says what pressing it does. */
    submitLabel: (label: string) => (error ? 'Try again' : label),
    handlers: () => {
      setError(null);
      return {
        onDone: () => {
          if (mounted.current) onSaved();
        },
        onError: (cause: unknown) => {
          if (!mounted.current) return;
          // Deleted elsewhere: a retry cannot succeed, so close; a toast says why.
          if (isNotFound(cause)) onSaved();
          else setError(cause instanceof Error ? cause.message : String(cause));
        },
      };
    },
  };
}

/** Why the last save failed; the form keeps what was typed so it can be saved again. */
export function SaveError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className={styles.error}>
      <CircleAlert size={14} aria-hidden />
      Could not save: {error.replace(/\.+$/, '')}. Your changes are still here.
    </p>
  );
}
