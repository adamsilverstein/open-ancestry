import { useEffect, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { fieldError, friendlyMessage, type FieldError } from '../../../api/edits';
import styles from './Edit.module.css';

/**
 * State for a form that stays open until its save succeeds: the error to
 * show, and handlers to pass to `edit.mutate` as `onDone` and `onError`.
 */
export function useSaveState<T = unknown>(onSaved: (result: T) => void) {
  const [error, setError] = useState<string | null>(null);
  // The field a server validation error names, so the form can mark it.
  const [field, setField] = useState<FieldError | null>(null);
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
    field,
    /** Clears a stale error, e.g. when another form opens. */
    reset: () => {
      setError(null);
      setField(null);
    },
    /** Label for the submit button: after a failure it says what pressing it does. */
    submitLabel: (label: string) => (error ? 'Try again' : label),
    handlers: () => {
      setError(null);
      setField(null);
      return {
        onDone: (result: T) => {
          if (mounted.current) onSaved(result);
        },
        // Plain sentences only: a server validation error never shows its schema text.
        onError: (cause: unknown) => {
          if (!mounted.current) return;
          setError(friendlyMessage(cause));
          setField(fieldError(cause));
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
