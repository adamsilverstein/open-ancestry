import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { actionFilter } from '../../lib/filter';
import selectStyles from '../Select/Select.module.css';
import dialogStyles from '../Dialog/Dialog.module.css';
import styles from './CommandPalette.module.css';

export interface PaletteAction {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Secondary line, e.g. lifespan and birthplace for a person. */
  description?: ReactNode;
  /** Extra words that should match, e.g. `dark light` for the theme action. */
  keywords?: string[];
  shortcut?: string;
  onSelect: () => void;
  /** Runs on Shift+Enter or Alt+Enter instead of `onSelect`. */
  onAltSelect?: () => void;
  /** Shown dimmed and skipped by the keyboard, e.g. results for an older query. */
  disabled?: boolean;
}

export interface PaletteGroup {
  heading: string;
  items: PaletteAction[];
  /** Items already filtered elsewhere (server search): always shown, in order. */
  unfiltered?: boolean;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: PaletteGroup[];
  /** Search text changes, for wiring people and place search. */
  onQueryChange?: (query: string) => void;
  placeholder?: string;
  /** Accessible name of the dialog and list (default "Command palette"). */
  title?: string;
  /** Set false when every group is filtered elsewhere (default true). */
  shouldFilter?: boolean;
  /** Shown under the list, e.g. what Enter and Shift+Enter do. */
  footer?: ReactNode;
  /** Announced and shown while results load. */
  loading?: boolean;
  /**
   * Results for the current query are still on the way. Enter pressed now,
   * with nothing selectable highlighted, runs on the first result once they arrive.
   */
  pending?: boolean;
}

/** Item values are ids, so two people with the same name stay distinct. */
const itemValue = (item: PaletteAction) => `${item.id}`;

/** Cmd/Ctrl-K palette. Selecting an item closes the palette, then runs it. */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  onQueryChange,
  placeholder = 'Search people, places, actions',
  title = 'Command palette',
  shouldFilter = true,
  footer,
  loading = false,
  pending = false,
}: CommandPaletteProps) {
  // Opened by shortcut, not a Radix trigger, so remember where focus was and restore it.
  const returnFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [value, setValue] = useState('');

  const byValue = new Map(
    groups.flatMap((g) => g.items.map((i) => [itemValue(i).toLowerCase(), i] as const)),
  );
  const labels = new Map([...byValue].map(([v, i]) => [v, i.label]));
  const unfiltered = new Set(
    groups
      .filter((g) => g.unfiltered)
      .flatMap((g) => g.items.map((i) => itemValue(i).toLowerCase())),
  );
  const visibleItems = groups.flatMap((g) =>
    g.items.filter(
      (i) =>
        !i.disabled &&
        (g.unfiltered ||
          !shouldFilter ||
          !query.trim() ||
          actionFilter(i.label, query, i.keywords) > 0),
    ),
  );
  const visible = visibleItems.map(itemValue);
  // When the visible list changes (typing, async results), highlight its first item.
  const firstVisible = visible[0] ?? '';
  const visibleKey = visible.join('\n');
  const [shownKey, setShownKey] = useState(visibleKey);
  if (shownKey !== visibleKey) {
    setShownKey(visibleKey);
    setValue(firstVisible);
  }

  const close = () => {
    queued.current = null;
    setQuery('');
    onQueryChange?.('');
    onOpenChange(false);
  };

  const run = (item: PaletteAction, alt: boolean) => {
    close();
    (alt && item.onAltSelect ? item.onAltSelect : item.onSelect)();
  };

  // Enter pressed before the current query's results arrived.
  const queued = useRef<{ alt: boolean } | null>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    const alt = event.shiftKey || event.altKey;
    // cmdk owns the highlighted item; read it from the DOM like its own Enter handler does.
    const selected = (event.currentTarget as HTMLElement)
      .querySelector('[cmdk-item][aria-selected="true"]:not([aria-disabled="true"])')
      ?.getAttribute('data-value');
    const item = selected ? byValue.get(selected.toLowerCase()) : undefined;
    if (!item && pending) {
      event.preventDefault();
      queued.current = { alt };
      return;
    }
    if (!alt || !item?.onAltSelect) return;
    event.preventDefault();
    run(item, true);
  };

  const firstItem = visibleItems[0];
  useEffect(() => {
    if (pending || !queued.current) return;
    const { alt } = queued.current;
    queued.current = null;
    if (firstItem) run(firstItem, alt);
  });

  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={dialogStyles.overlay} />
        <RadixDialog.Content
          className={styles.content}
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement as HTMLElement | null;
          }}
          onCloseAutoFocus={(event) => {
            // An action that opened a dialog (such as Add person) keeps the focus it moved there.
            if (document.querySelector('[role="dialog"][data-state="open"]')) {
              event.preventDefault();
              return;
            }
            if (!returnFocus.current?.isConnected) return;
            event.preventDefault();
            returnFocus.current.focus();
          }}
        >
          <RadixDialog.Title className="oa-visually-hidden">{title}</RadixDialog.Title>
          <Command
            // Server results arrive pre-ranked and score 1; local actions match the
            // start of their label or a whole keyword and score lower, so they sort after.
            filter={(itemValue, search, keywords) =>
              unfiltered.has(itemValue.toLowerCase())
                ? 1
                : actionFilter(labels.get(itemValue.toLowerCase()) ?? itemValue, search, keywords)
            }
            shouldFilter={shouldFilter}
            label={title}
            loop
            value={value}
            onValueChange={setValue}
            onKeyDown={onKeyDown}
          >
            <div className={styles.inputRow}>
              <Search size={18} aria-hidden className={styles.searchIcon} />
              <Command.Input
                className={styles.input}
                placeholder={placeholder}
                aria-label={placeholder}
                value={query}
                onValueChange={(next) => {
                  setQuery(next);
                  onQueryChange?.(next);
                }}
              />
            </div>
            <Command.List className={styles.list} aria-busy={loading || undefined}>
              {!loading && <Command.Empty className={styles.empty}>No results</Command.Empty>}
              {loading && visible.length === 0 && (
                <Command.Loading className={styles.empty}>Searching…</Command.Loading>
              )}
              {groups.map((group) => (
                <Command.Group key={group.heading} heading={group.heading} className={styles.group}>
                  {group.items.map((item) => (
                    <Command.Item
                      key={item.id}
                      value={itemValue(item)}
                      keywords={item.keywords}
                      disabled={item.disabled}
                      className={selectStyles.item}
                      onSelect={() => run(item, false)}
                    >
                      <span className={styles.itemLabel}>
                        {item.icon}
                        {item.description ? (
                          <span className={styles.itemText}>
                            <span className={styles.itemTitle}>{item.label}</span>
                            <span className={styles.itemDescription}>{item.description}</span>
                          </span>
                        ) : (
                          item.label
                        )}
                      </span>
                      {item.shortcut && <kbd className={styles.kbd}>{item.shortcut}</kbd>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
            {footer && <div className={styles.footer}>{footer}</div>}
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
