import { useRef, type ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Button } from '../Button/Button';
import dialogStyles from '../Dialog/Dialog.module.css';
import { cx } from '../../lib/cx';
import { captureOpener, returnFocus } from '../../lib/returnFocus';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  /** Destructive actions get the danger button. */
  danger?: boolean;
}

/**
 * Alert dialog for confirming an action: Cancel has initial focus so Enter
 * never confirms by accident; Escape cancels.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  danger = true,
}: ConfirmDialogProps) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={cx(dialogStyles.overlay, styles.overlay)} />
        <RadixDialog.Content
          role="alertdialog"
          onOpenAutoFocus={() => {
            opener.current = captureOpener();
          }}
          onCloseAutoFocus={(event) => {
            if (returnFocus(opener.current)) event.preventDefault();
          }}
          className={cx(dialogStyles.content, dialogStyles.sm, styles.content)}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <RadixDialog.Title className={dialogStyles.title}>{title}</RadixDialog.Title>
          {description && (
            <RadixDialog.Description className={dialogStyles.description}>
              {description}
            </RadixDialog.Description>
          )}
          <div className={dialogStyles.footer}>
            <RadixDialog.Close asChild>
              <Button variant="ghost">Cancel</Button>
            </RadixDialog.Close>
            <Button
              variant={danger ? 'danger' : 'primary'}
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
