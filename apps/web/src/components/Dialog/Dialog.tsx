import type { ReactElement, ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cx } from '../../lib/cx';
import { IconButton } from '../IconButton/IconButton';
import styles from './Dialog.module.css';

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
  /** Override where focus lands on open (call `event.preventDefault()` and focus yourself). */
  onOpenAutoFocus?: (event: Event) => void;
  className?: string;
  children?: ReactNode;
}

/** Modal dialog: focus trapped, Escape and close button dismiss, focus restored. */
export function Dialog({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  description,
  trigger,
  footer,
  size = 'md',
  onOpenAutoFocus,
  className,
  children,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={cx(styles.content, styles[size], className)}
          onOpenAutoFocus={onOpenAutoFocus}
          // Radix wires aria-describedby to the Description; opt out when there is none.
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <RadixDialog.Title className={cx(styles.title, hideTitle && 'oa-visually-hidden')}>
            {title}
          </RadixDialog.Title>
          {description && (
            <RadixDialog.Description className={styles.description}>
              {description}
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
