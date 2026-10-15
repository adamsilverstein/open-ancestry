import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Redo2, Undo2 } from 'lucide-react';
import { historyQuery, undoRedo, undoRedoMessage } from '../api/history';
import { currentTreeQuery } from '../api/queries';
import { useOpenRestored } from '../lib/useOpenRestored';
import { Button } from '../components/Button/Button';
import { Dialog } from '../components/Dialog/Dialog';
import { useToast } from '../components/Toast/Toast';
import styles from './HistoryPanel.module.css';

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** `2 minutes ago`, `yesterday`. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

interface HistoryPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Recent changes to the open tree, newest first, with undo and redo. */
export default function HistoryPanel({ open, onOpenChange }: HistoryPanelProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const onRestored = useOpenRestored();
  const { data: tree } = useQuery(currentTreeQuery);
  const { data: history } = useQuery({ ...historyQuery(tree ?? ''), enabled: !!tree });

  const run = async (direction: 'undo' | 'redo') => {
    try {
      const result = await undoRedo(queryClient, direction, { onRestored });
      // The panel shows what changed; only a step-over needs saying.
      if (result.skipped.length) toast({ ...undoRedoMessage(direction, result), duration: 6000 });
    } catch (error) {
      toast({
        title: `Could not ${direction}`,
        description: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="History"
      description="Every change to this tree. Undo and redo also work with Ctrl+Z and Shift+Ctrl+Z (⌘ on a Mac)."
      footer={
        <>
          <Button
            iconStart={<Undo2 size={16} aria-hidden />}
            disabled={!history?.canUndo}
            onClick={() => void run('undo')}
          >
            Undo
          </Button>
          <Button
            iconStart={<Redo2 size={16} aria-hidden />}
            disabled={!history?.canRedo}
            onClick={() => void run('redo')}
          >
            Redo
          </Button>
        </>
      }
    >
      {!history ? (
        <p className={styles.muted}>Loading…</p>
      ) : history.items.length === 0 ? (
        <p className={styles.muted}>No changes yet.</p>
      ) : (
        // Focusable so the list can be scrolled from the keyboard (axe scrollable-region-focusable).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <ol className={styles.list} aria-label="Changes" tabIndex={0}>
          {history.items.map((batch) => (
            <li key={batch.id} className={batch.state === 'undone' ? styles.undone : undefined}>
              <span className={styles.label}>{batch.label}</span>
              {batch.state === 'undone' && <span className={styles.chip}>undone</span>}
              <time className={styles.time} dateTime={batch.created_at}>
                {timeAgo(batch.created_at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
