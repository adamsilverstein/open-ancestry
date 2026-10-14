import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react';
import * as RadixToast from '@radix-ui/react-toast';
import { CircleAlert, Info, X } from 'lucide-react';
import { cx } from '../../lib/cx';
import styles from './Toast.module.css';

export type ToastVariant = 'info' | 'error';

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

type ShowToast = (options: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

/** Returns `toast(options)`; must be used inside `ToastProvider`. */
export function useToast(): ShowToast {
  const toast = use(ToastContext);
  if (!toast) throw new Error('useToast must be used inside ToastProvider');
  return toast;
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const show = useCallback<ShowToast>((options) => {
    setToasts((list) => [...list, { ...options, id: nextId++ }]);
  }, []);
  const remove = (id: number) => setToasts((list) => list.filter((t) => t.id !== id));
  const value = useMemo(() => show, [show]);

  return (
    <ToastContext value={value}>
      <RadixToast.Provider swipeDirection="right" label="Notifications">
        {children}
        {toasts.map(({ id, title, description, variant = 'info', duration = 5000 }) => (
          <RadixToast.Root
            key={id}
            duration={duration}
            className={cx(styles.toast, styles[variant])}
            onOpenChange={(open) => !open && remove(id)}
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
            <RadixToast.Close className={styles.close} aria-label="Dismiss">
              <X size={16} aria-hidden />
            </RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className={styles.viewport} />
      </RadixToast.Provider>
    </ToastContext>
  );
}
