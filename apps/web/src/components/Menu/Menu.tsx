import type { ComponentProps } from 'react';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import { cx } from '../../lib/cx';
import selectStyles from '../Select/Select.module.css';
import styles from './Menu.module.css';

export const Menu = RadixMenu.Root;
export const MenuTrigger = RadixMenu.Trigger;
export const MenuRadioGroup = RadixMenu.RadioGroup;

export function MenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof RadixMenu.Content>) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        className={cx(selectStyles.content, styles.content, className)}
        sideOffset={sideOffset}
        collisionPadding={8}
        {...props}
      />
    </RadixMenu.Portal>
  );
}

export function MenuItem({ className, ...props }: ComponentProps<typeof RadixMenu.Item>) {
  return <RadixMenu.Item className={cx(selectStyles.item, styles.item, className)} {...props} />;
}

export function MenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof RadixMenu.RadioItem>) {
  return (
    <RadixMenu.RadioItem className={cx(selectStyles.item, styles.item, className)} {...props}>
      {children}
      <RadixMenu.ItemIndicator className={selectStyles.indicator}>
        <Check size={16} aria-hidden />
      </RadixMenu.ItemIndicator>
    </RadixMenu.RadioItem>
  );
}

export function MenuSeparator() {
  return <RadixMenu.Separator className={styles.separator} />;
}
