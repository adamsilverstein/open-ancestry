import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { undoRedo } from '../api/history';
import { useToast } from '../components/Toast/Toast';

/** Text fields keep their own Cmd/Ctrl-Z. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type))
  );
}

/**
 * An open dialog or popover owns the keyboard: undoing behind an edit form
 * would leave it showing stale values that its Save would write back.
 */
function dialogOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ) !== null
  );
}

/** Which history action a key press asks for: Cmd/Ctrl-Z, Shift-Cmd/Ctrl-Z or Ctrl-Y. */
export function historyShortcut(event: KeyboardEvent): 'undo' | 'redo' | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.shiftKey) return 'redo';
  return null;
}

/** Global undo and redo for tree edits, with a toast naming what changed. */
export function UndoShortcuts() {
  const queryClient = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    let busy = false;
    async function onKeyDown(event: KeyboardEvent) {
      const action = historyShortcut(event);
      if (!action || isEditable(event.target) || dialogOpen()) return;
      event.preventDefault();
      // One at a time: rapid presses queue up rather than race.
      while (busy) await new Promise((resolve) => setTimeout(resolve, 20));
      busy = true;
      try {
        const batch = await undoRedo(queryClient, action);
        toast({
          title: batch
            ? `${action === 'undo' ? 'Undid' : 'Redid'} ${batch.label}`
            : `Nothing to ${action}`,
          duration: 3000,
        });
      } catch (error) {
        toast({
          title: `Could not ${action}`,
          description: error instanceof Error ? error.message : String(error),
          variant: 'error',
        });
      } finally {
        busy = false;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [queryClient, toast]);
  return null;
}
