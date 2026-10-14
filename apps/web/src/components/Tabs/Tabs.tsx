import type { ComponentProps } from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import { cx } from '../../lib/cx';
import styles from './Tabs.module.css';

export const Tabs = RadixTabs.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof RadixTabs.List>) {
  return <RadixTabs.List className={cx(styles.list, className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return <RadixTabs.Trigger className={cx(styles.trigger, className)} {...props} />;
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cx(styles.content, className)} {...props} />;
}
