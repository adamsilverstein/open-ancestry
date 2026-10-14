import { useRef, type ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { substringFilter } from '../../lib/filter';
import selectStyles from '../Select/Select.module.css';
import dialogStyles from '../Dialog/Dialog.module.css';
import styles from './CommandPalette.module.css';

export interface PaletteAction {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Extra words that should match, e.g. `dark light` for the theme action. */
  keywords?: string[];
  shortcut?: string;
  onSelect: () => void;
}

export interface PaletteGroup {
  heading: string;
  items: PaletteAction[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: PaletteGroup[];
  /** Search text changes, for wiring people and place search. */
  onQueryChange?: (query: string) => void;
  placeholder?: string;
  /** Dialog name for assistive tech. */
  title?: string;
  /** Turn off client filtering when the items are already search results. */
  shouldFilter?: boolean;
}

/** Cmd/Ctrl-K palette. Selecting an item closes the palette, then runs it. */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  onQueryChange,
  placeholder = 'Search people, places, actions',
  title = 'Command palette',
  shouldFilter = true,
}: CommandPaletteProps) {
  // Opened by shortcut, not a Radix trigger, so remember where focus was and restore it.
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={dialogStyles.overlay} />
        <RadixDialog.Content
          className={styles.content}
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement as HTMLElement | null;
          }}
          onCloseAutoFocus={(event) => {
            if (!returnFocus.current?.isConnected) return;
            event.preventDefault();
            returnFocus.current.focus();
          }}
        >
          <RadixDialog.Title className="oa-visually-hidden">{title}</RadixDialog.Title>
          <Command filter={substringFilter} shouldFilter={shouldFilter} label={title} loop>
            <div className={styles.inputRow}>
              <Search size={18} aria-hidden className={styles.searchIcon} />
              <Command.Input
                className={styles.input}
                placeholder={placeholder}
                aria-label={placeholder}
                onValueChange={onQueryChange}
              />
            </div>
            <Command.List className={styles.list}>
              <Command.Empty className={styles.empty}>No results</Command.Empty>
              {groups.map((group) => (
                <Command.Group key={group.heading} heading={group.heading} className={styles.group}>
                  {group.items.map((item) => (
                    <Command.Item
                      key={item.id}
                      value={item.label}
                      keywords={item.keywords}
                      className={selectStyles.item}
                      onSelect={() => {
                        onOpenChange(false);
                        item.onSelect();
                      }}
                    >
                      <span className={styles.itemLabel}>
                        {item.icon}
                        {item.label}
                      </span>
                      {item.shortcut && <kbd className={styles.kbd}>{item.shortcut}</kbd>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
