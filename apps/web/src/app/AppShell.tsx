import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet } from '@tanstack/react-router';
import { ToastProvider } from '../components/Toast/Toast';
import { ChunkBoundary } from '../lib/ChunkBoundary';
import { trackFocus } from '../lib/returnFocus';
import { PaletteContext } from './palette';
import { TopBar } from './TopBar';
import { UndoShortcuts } from './UndoShortcuts';
import styles from './AppShell.module.css';

const loadPalette = () => import('./ShellCommandPalette');
const ShellCommandPalette = lazy(loadPalette);

/** Cmd on macOS, Ctrl elsewhere; both work everywhere. */
function isPaletteShortcut(event: KeyboardEvent) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k';
}

/** A key that types one character (not a shortcut, not a dead or named key). */
function isTyping(event: KeyboardEvent) {
  return !event.metaKey && !event.ctrlKey && !event.altKey && [...event.key].length === 1;
}

export function AppShell() {
  const [paletteOpen, setPaletteOpenState] = useState(false);
  // The palette chunk loads on first use, then stays mounted so it opens instantly.
  const [paletteLoaded, setPaletteLoaded] = useState(false);
  const openRef = useRef(false);
  // Keys typed between opening the palette and its input taking focus (the first open
  // waits for the chunk); the palette takes them as its starting query.
  const typeAhead = useRef<string | null>(null);

  const palette = useMemo(() => {
    const setOpen = (open: boolean) => {
      if (open && !openRef.current) {
        typeAhead.current = '';
        // Typing must never stay captured when the chunk cannot load.
        loadPalette().catch(() => {
          typeAhead.current = null;
        });
      }
      if (!open) typeAhead.current = null;
      openRef.current = open;
      if (open) setPaletteLoaded(true);
      setPaletteOpenState(open);
    };
    return {
      open: () => setOpen(true),
      setOpen,
      toggle: () => setOpen(!openRef.current),
      takeTypeAhead: () => {
        const typed = typeAhead.current ?? '';
        typeAhead.current = null;
        return typed;
      },
    };
  }, []);

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
      palette.toggle();
    }
    // Capture phase, so a buffered key never reaches the page behind the palette.
    function onTypeAhead(event: KeyboardEvent) {
      const typed = typeAhead.current;
      if (typed === null || event.isComposing) return;
      if (event.key === 'Escape') palette.setOpen(false);
      else if (event.key === 'Backspace') typeAhead.current = typed.slice(0, -1);
      else if (isTyping(event)) typeAhead.current = typed + event.key;
      // Enter has nothing to choose yet, and must not press whatever had focus.
      else if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onTypeAhead, { capture: true });
    // Lets tests (and anything else) know global shortcuts are live.
    document.documentElement.dataset.shellReady = '';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onTypeAhead, { capture: true });
      delete document.documentElement.dataset.shellReady;
    };
  }, [palette]);

  return (
    <PaletteContext value={palette}>
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
              <ShellCommandPalette
                open={paletteOpen}
                onOpenChange={palette.setOpen}
                takeTypeAhead={palette.takeTypeAhead}
              />
            </Suspense>
          </ChunkBoundary>
        )}
      </ToastProvider>
    </PaletteContext>
  );
}
