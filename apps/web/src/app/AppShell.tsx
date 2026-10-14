import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { currentTreeQuery } from '../api/queries';
import { AddPersonContext } from './addPerson';
import { ToastProvider } from '../components/Toast/Toast';
import { ChunkBoundary } from '../lib/ChunkBoundary';
import { trackFocus } from '../lib/returnFocus';
import { PaletteContext } from './palette';
import { TopBar } from './TopBar';
import { UndoShortcuts } from './UndoShortcuts';
import styles from './AppShell.module.css';

const loadPalette = () => import('./ShellCommandPalette');
const ShellCommandPalette = lazy(loadPalette);
const AddPersonDialog = lazy(() => import('./AddPersonDialog'));

/** Cmd on macOS, Ctrl elsewhere; both work everywhere. */
function isPaletteShortcut(event: KeyboardEvent) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k';
}

/** The focused control outside any dialog, or null. */
function focusedOutsideDialogs(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  return active.closest('[role="dialog"], [role="alertdialog"]') ? null : active;
}

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  // What had focus before the palette opened: a dialog launched from the
  // palette returns focus there, since the palette's input is gone by then.
  const beforePalette = useRef<HTMLElement | null>(null);
  // The palette chunk loads on first use, then stays mounted so it opens instantly.
  const [paletteLoaded, setPaletteLoaded] = useState(false);

  const palette = useMemo(
    () => ({
      open: () => {
        beforePalette.current = focusedOutsideDialogs();
        setPaletteLoaded(true);
        setPaletteOpen(true);
      },
    }),
    [],
  );

  const { data: tree = null } = useQuery(currentTreeQuery);
  // Bumped on every open so each Add person starts with an empty form.
  const [addPersonKey, setAddPersonKey] = useState(0);
  const [addPersonOpen, setAddPersonOpen] = useState(false);
  const [addPersonOpener, setAddPersonOpener] = useState<HTMLElement | null>(null);
  const addPerson = useMemo(
    () => ({
      open: () => {
        setAddPersonOpener(focusedOutsideDialogs() ?? beforePalette.current);
        setAddPersonKey((key) => key + 1);
        setAddPersonOpen(true);
      },
    }),
    [],
  );

  // Fetch the palette chunk once the page is idle so Cmd-K never waits on the network.
  useEffect(() => {
    const id = setTimeout(() => void loadPalette().catch(() => {}), 1500);
    return () => clearTimeout(id);
  }, []);

  // Dialogs opened from menus or plain buttons return focus to the last control used.
  useEffect(trackFocus, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      setPaletteLoaded(true);
      // Focus is inside the palette while it is open, so this only records on open.
      beforePalette.current = focusedOutsideDialogs() ?? beforePalette.current;
      setPaletteOpen((open) => !open);
    }
    window.addEventListener('keydown', onKeyDown);
    // Lets tests (and anything else) know global shortcuts are live.
    document.documentElement.dataset.shellReady = '';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      delete document.documentElement.dataset.shellReady;
    };
  }, []);

  return (
    <PaletteContext value={palette}>
      <AddPersonContext value={addPerson}>
        <ToastProvider>
          <UndoShortcuts />
          <a className={styles.skipLink} href="#main">
            Skip to content
          </a>
          <TopBar onFind={palette.open} />
          <main id="main" className={styles.main} tabIndex={-1}>
            <Outlet />
          </main>
          {paletteLoaded && (
            <ChunkBoundary fallback={null}>
              <Suspense fallback={null}>
                <ShellCommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
              </Suspense>
            </ChunkBoundary>
          )}
          {tree && addPersonKey > 0 && (
            <ChunkBoundary fallback={null}>
              <Suspense fallback={null}>
                <AddPersonDialog
                  key={addPersonKey}
                  opener={addPersonOpener}
                  tree={tree}
                  open={addPersonOpen}
                  onOpenChange={setAddPersonOpen}
                />
              </Suspense>
            </ChunkBoundary>
          )}
        </ToastProvider>
      </AddPersonContext>
    </PaletteContext>
  );
}
