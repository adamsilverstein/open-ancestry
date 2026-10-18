import { useEffect, useState } from 'react';
import { cx } from '../../lib/cx';
import type { ToastItem } from './Toast';
import styles from './Toast.module.css';
import { withIsolates } from '../../lib/isolates';

/**
 * Toasts without Radix, for when its chunk cannot load (offline, or a new
 * build replaced the chunk). Each message shows for its duration; the newest
 * is announced through one polite status region that is cleared and then
 * set, which screen readers pick up more reliably than inserted nodes.
 */
export function ToastFallback({
  toasts,
  onRemove,
}: {
  toasts: ToastItem[];
  onRemove: (id: number) => void;
}) {
  const [announcement, setAnnouncement] = useState('');
  const latest = toasts.at(-1);
  const latestText = latest ? [latest.title, latest.description].filter(Boolean).join('. ') : '';

  useEffect(() => {
    const timers = toasts.map(({ id, duration = 5000 }) =>
      setTimeout(() => onRemove(id), duration),
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts, onRemove]);

  useEffect(() => {
    if (!latestText) return;
    const frame = requestAnimationFrame(() => setAnnouncement(latestText));
    return () => {
      cancelAnimationFrame(frame);
      setAnnouncement('');
    };
  }, [latest?.id, latestText]);

  return (
    <>
      <div role="status" aria-live="polite" className="oa-visually-hidden">
        {announcement}
      </div>
      <ol className={styles.viewport} aria-hidden>
        {toasts.map(({ id, title, description, variant = 'info' }) => (
          <li key={id} className={cx(styles.toast, styles[variant])} data-testid="toast-fallback">
            <div className={styles.body}>
              <p className={styles.title}>{withIsolates(title)}</p>
              {description && <p className={styles.description}>{withIsolates(description)}</p>}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
