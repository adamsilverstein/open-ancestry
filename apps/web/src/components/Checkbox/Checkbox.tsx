import { useEffect, useId, useRef, type ComponentProps, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type' | 'id'> {
  label: string;
  /** Shown under the label and announced with the checkbox (aria-describedby). */
  description?: ReactNode;
  indeterminate?: boolean;
}

/** Native checkbox styled with tokens: free keyboard and form support. */
export function Checkbox({
  label,
  description,
  indeterminate = false,
  className,
  ...rest
}: CheckboxProps) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <div className={cx(styles.row, className)}>
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className={styles.checkbox}
        aria-describedby={description ? `${id}-desc` : undefined}
        {...rest}
      />
      <div>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        {description && (
          <p id={`${id}-desc`} className={styles.description}>
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
