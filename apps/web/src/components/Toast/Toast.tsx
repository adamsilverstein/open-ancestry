import {
  createContext,
  lazy,
  Suspense,
  use,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ToastVariant = 'info' | 'error';

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. */
  duration?: number;
}

export interface ToastItem extends ToastOptions {
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

const ToastStack = lazy(() => import('./ToastStack'));

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Mounted from the first toast on, so later toasts and exit animations stay smooth.
  const [shown, setShown] = useState(false);
  const show = useCallback<ShowToast>((options) => {
    setShown(true);
    setToasts((list) => [...list, { ...options, id: nextId++ }]);
  }, []);
  const remove = useCallback(
    (id: number) => setToasts((list) => list.filter((t) => t.id !== id)),
    [],
  );
  const value = useMemo(() => show, [show]);

  return (
    <ToastContext value={value}>
      {children}
      {shown && (
        <Suspense fallback={null}>
          <ToastStack toasts={toasts} onRemove={remove} />
        </Suspense>
      )}
    </ToastContext>
  );
}
