import type { ReactElement, ReactNode } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import styles from './Tooltip.module.css';

/** Optional: wrap a group of tooltips so moving between them skips the open delay. */
export const TooltipProvider = RadixTooltip.Provider;

export interface TooltipProps {
  content: ReactNode;
  /** Keyboard shortcut shown after the label, e.g. `+` or `Ctrl K`. */
  shortcut?: string | undefined;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** A single focusable element; it receives the trigger props. */
  children: ReactElement;
}

export function Tooltip({ content, shortcut, side = 'top', children }: TooltipProps) {
  // Each tooltip carries its own provider so the app shell does not need one on the initial bundle.
  return (
    <RadixTooltip.Provider delayDuration={400}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className={styles.content} side={side} sideOffset={6}>
            {content}
            {shortcut && <kbd className={styles.kbd}>{shortcut}</kbd>}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
