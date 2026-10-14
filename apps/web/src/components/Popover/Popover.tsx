import type { ComponentProps } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { cx } from '../../lib/cx';
import styles from './Popover.module.css';

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

export interface PopoverContentProps extends ComponentProps<typeof RadixPopover.Content> {
  /** Accessible name; popovers render as labelled dialogs. */
  label: string;
}

export function PopoverContent({
  label,
  className,
  sideOffset = 6,
  ...props
}: PopoverContentProps) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        aria-label={label}
        className={cx(styles.content, className)}
        sideOffset={sideOffset}
        collisionPadding={8}
        {...props}
      />
    </RadixPopover.Portal>
  );
}
