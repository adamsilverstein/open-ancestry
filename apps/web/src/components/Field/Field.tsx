import { useId, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import styles from './Field.module.css';

export interface FieldProps {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  /** Renders the control with the ids and aria props it needs. */
  children: (control: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': true | undefined;
  }) => ReactNode;
}

/** Label, hint and error wiring shared by Input, Textarea, Select and Combobox. */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error && (
        <p id={errorId} className={styles.error}>
          <CircleAlert size={14} aria-hidden />
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
    </div>
  );
}
