import { useRef, type ReactElement, type ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cx } from '../../lib/cx';
import {
  captureOpener,
  lastControlOutside,
  mainLandmark,
  returnFocus,
} from '../../lib/returnFocus';
import { IconButton } from '../IconButton/IconButton';
import styles from './Dialog.module.css';
import { shownText, withIsolates } from '../../lib/isolates';

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  /** Hide the visible title (it stays the accessible name). */
  hideTitle?: boolean;
  description?: ReactNode;
  /** Element that opens the dialog; focus returns to it on close. */
  trigger?: ReactElement;
  /** Buttons rendered in the footer, right aligned. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Where focus goes on close when there is no trigger to return to (call preventDefault first). */
  onCloseAutoFocus?: (event: Event) => void;
  /** Override where focus lands on open (call `event.preventDefault()` and focus yourself). */
  onOpenAutoFocus?: (event: Event) => void;
  /** Where focus goes on close when the opener is gone, e.g. after deleting what it edited. */
  returnFocusFallback?: () => HTMLElement | null | undefined;
  className?: string;
  children?: ReactNode;
}

/** Escape keydowns re-sent to a confirm, with how many times, so retries stop. */
const resent = new WeakMap<Event, number>();

/** Whether a dialog opened after `own` (a confirm stacked above it) is still open. */
function coveredByAnotherDialog(own: HTMLElement | null): boolean {
  const open = document.querySelectorAll(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
  );
  const top = open[open.length - 1];
  return !!own && !!top && top !== own && !own.contains(top);
}

/** Modal dialog: focus trapped, Escape and close button dismiss, focus restored to the opener. */
export function Dialog({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  description,
  trigger,
  footer,
  size = 'md',
  onCloseAutoFocus,
  onOpenAutoFocus,
  returnFocusFallback,
  className,
  children,
}: DialogProps) {
  // What opened it, then the last control used outside overlays (for a dialog
  // opened from the command palette, whose input is gone by the time it closes).
  const opener = useRef<HTMLElement | null>(null);
  const outside = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={cx(styles.content, styles[size], className)}
          ref={content}
          onEscapeKeyDown={(event) => {
            // Escape belongs to the top layer. Radix can still route it here for a
            // moment after a confirm opens above (its listener attaches in an
            // effect), which would close this dialog and lose unsaved edits.
            if (!coveredByAnotherDialog(content.current)) return;
            event.preventDefault();
            // Hand the key to the confirm once its own listener is in place.
            const attempt = (resent.get(event) ?? 0) + 1;
            if (attempt > 20) return;
            setTimeout(() => {
              const again = new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
              });
              resent.set(again, attempt);
              document.dispatchEvent(again);
            }, 25);
          }}
          onOpenAutoFocus={(event) => {
            opener.current = captureOpener();
            outside.current = lastControlOutside();
            onOpenAutoFocus?.(event);
          }}
          onCloseAutoFocus={(event) => {
            if (onCloseAutoFocus) return onCloseAutoFocus(event);
            // A Trigger gets focus back from Radix; anything else would land on <body>.
            if (trigger) return;
            if (returnFocus(opener.current, outside.current, returnFocusFallback, mainLandmark))
              event.preventDefault();
          }}
          // Radix wires aria-describedby to the Description; opt out when there is none.
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <RadixDialog.Title className={cx(styles.title, hideTitle && 'oa-visually-hidden')}>
            {withIsolates(title)}
          </RadixDialog.Title>
          {description && (
            <RadixDialog.Description className={styles.description}>
              {shownText(description)}
            </RadixDialog.Description>
          )}
          {children}
          {footer && <div className={styles.footer}>{footer}</div>}
          {/* Last in DOM order so initial focus lands on the content, not on Close. */}
          <RadixDialog.Close asChild>
            <IconButton
              className={styles.close}
              label="Close"
              icon={<X size={18} aria-hidden />}
              size="sm"
              tooltip={false}
            />
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
