import {
  createContext,
  lazy,
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ChunkBoundary } from '../../lib/ChunkBoundary';
import { ToastFallback } from './ToastFallback';

export type ToastVariant = 'info' | 'error';

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. */
  duration?: number;
  /** Lets `useDismissToasts()` close it early, e.g. `batch:<id>` once that change is undone. */
  tag?: string;
  /** One button in the toast, e.g. Undo; keep the same action reachable elsewhere (a shortcut). */
  action?: { label: string; onClick: () => void };
}

export interface ToastItem extends ToastOptions {
  id: number;
}

type ShowToast = (options: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);
const DismissContext = createContext<((tag: string) => void) | null>(null);

/** Returns `toast(options)`; must be used inside `ToastProvider`. */
export function useToast(): ShowToast {
  const toast = use(ToastContext);
  if (!toast) throw new Error('useToast must be used inside ToastProvider');
  return toast;
}

/** Returns `dismiss(tag)`, which closes every toast shown with that `tag`. */
export function useDismissToasts(): (tag: string) => void {
  const dismiss = use(DismissContext);
  if (!dismiss) throw new Error('useDismissToasts must be used inside ToastProvider');
  return dismiss;
}

let nextId = 1;

const loadToastStack = () => import('./ToastStack');
const ToastStack = lazy(loadToastStack);

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
  const dismiss = useCallback(
    (tag: string) => setToasts((list) => list.filter((t) => t.tag !== tag)),
    [],
  );

  // Fetch the toast chunk once the page is idle: the first toast is often an
  // error, shown exactly when the network is least reliable.
  useEffect(() => {
    const id = setTimeout(() => void loadToastStack().catch(() => {}), 2000);
    return () => clearTimeout(id);
  }, []);

  return (
    <ToastContext value={value}>
      <DismissContext value={dismiss}>{children}</DismissContext>
      {shown && (
        <ChunkBoundary fallback={<ToastFallback toasts={toasts} onRemove={remove} />}>
          <Suspense fallback={null}>
            <ToastStack toasts={toasts} onRemove={remove} />
          </Suspense>
        </ChunkBoundary>
      )}
    </ToastContext>
  );
}
