import { useEffect } from 'react';
import { cx } from '../../lib/cx';
import type { ToastItem } from './Toast';
import styles from './Toast.module.css';

/**
 * Toasts without Radix, for when its chunk cannot load (offline, or a new
 * build replaced the chunk): a polite live region that still shows each
 * message and removes it after its duration.
 */
export function ToastFallback({
  toasts,
  onRemove,
}: {
  toasts: ToastItem[];
  onRemove: (id: number) => void;
}) {
  useEffect(() => {
    const timers = toasts.map(({ id, duration = 5000 }) =>
      setTimeout(() => onRemove(id), duration),
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts, onRemove]);
  return (
    <ol className={styles.viewport} aria-label="Notifications">
      {toasts.map(({ id, title, description, variant = 'info' }) => (
        <li key={id} role="status" className={cx(styles.toast, styles[variant])}>
          <div className={styles.body}>
            <p className={styles.title}>{title}</p>
            {description && <p className={styles.description}>{description}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
