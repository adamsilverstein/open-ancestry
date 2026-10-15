import * as RadixToast from '@radix-ui/react-toast';
import { CircleAlert, Info, X } from 'lucide-react';
import { cx } from '../../lib/cx';
import type { ToastItem } from './Toast';
import styles from './Toast.module.css';

/** The toasts on screen. Loaded with the first toast, so Radix Toast stays out of the initial bundle. */
export default function ToastStack({
  toasts,
  onRemove,
}: {
  toasts: ToastItem[];
  onRemove: (id: number) => void;
}) {
  return (
    <RadixToast.Provider swipeDirection="right" label="Notifications">
      {toasts.map(({ id, title, description, variant = 'info', duration = 5000, action }) => (
        <RadixToast.Root
          key={id}
          duration={duration}
          className={cx(styles.toast, styles[variant])}
          onOpenChange={(open) => !open && onRemove(id)}
        >
          {variant === 'error' ? (
            <CircleAlert className={styles.icon} size={18} aria-hidden />
          ) : (
            <Info className={styles.icon} size={18} aria-hidden />
          )}
          <div className={styles.body}>
            <RadixToast.Title className={styles.title}>{title}</RadixToast.Title>
            {description && (
              <RadixToast.Description className={styles.description}>
                {description}
              </RadixToast.Description>
            )}
          </div>
          {action && (
            <RadixToast.Action asChild altText={`${action.label}: ${title}`}>
              <button type="button" className={styles.action} onClick={action.onClick}>
                {action.label}
              </button>
            </RadixToast.Action>
          )}
          <RadixToast.Close className={styles.close} aria-label="Dismiss">
            <X size={16} aria-hidden />
          </RadixToast.Close>
        </RadixToast.Root>
      ))}
      <RadixToast.Viewport className={styles.viewport} />
    </RadixToast.Provider>
  );
}
