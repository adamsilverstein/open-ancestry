import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type LazyExoticComponent,
} from 'react';
import type ShellCommandPaletteType from './ShellCommandPalette';
import type { TypeAhead } from '../components/CommandPalette/CommandPalette';
import { Outlet } from '@tanstack/react-router';
import { ToastProvider } from '../components/Toast/Toast';
import { ChunkBoundary } from '../lib/ChunkBoundary';
import { trackFocus } from '../lib/returnFocus';
import { PaletteContext } from './palette';
import { TopBar } from './TopBar';
import { UndoShortcuts } from './UndoShortcuts';
import styles from './AppShell.module.css';

const loadPalette = () => import('./ShellCommandPalette');

/**
 * One lazy palette per load attempt: React.lazy keeps a failed load's error, so a
 * retry after the chunk failed (the network came back) needs a fresh one.
 */
const palettes: LazyExoticComponent<typeof ShellCommandPaletteType>[] = [];
const paletteFor = (attempt: number) => (palettes[attempt] ??= lazy(loadPalette));

/** Cmd on macOS, Ctrl elsewhere; both work everywhere. */
function isPaletteShortcut(event: KeyboardEvent) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k';
}

/**
 * A key that types text: not a named key (`Enter`, `ArrowLeft`, `F1`, `Dead`,
 * `Process` during IME composition) and not a shortcut. AltGr (reported as
 * Ctrl+Alt on Windows and Linux) and macOS Option type characters, and a key
 * may produce several code points (a conjunct, a decomposed accent).
 */
function isTyping(event: KeyboardEvent) {
  if (event.metaKey || /^[A-Z][A-Za-z0-9]+$/.test(event.key)) return false;
  const altGr = event.getModifierState('AltGraph') || (event.ctrlKey && event.altKey);
  return altGr || !event.ctrlKey;
}

/** Keys that would move focus or a selection behind the palette while it loads. */
const HELD_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Tab',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** Typing is released to the page if the palette has not taken it this long after its chunk loaded. */
const TYPE_AHEAD_LIMIT_MS = 3000;

export function AppShell() {
  const [paletteOpen, setPaletteOpenState] = useState(false);
  // The palette chunk loads on first use, then stays mounted so it opens instantly.
  const [paletteLoaded, setPaletteLoaded] = useState(false);
  // A new attempt (a fresh lazy component and boundary) after the chunk failed to load.
  const [attempt, setAttempt] = useState(0);
  const ShellCommandPalette = paletteFor(attempt);
  const openRef = useRef(false);
  const failedRef = useRef(false);
  // Keys typed between opening the palette and its input taking focus (the first open
  // waits for the chunk); the palette takes them as its starting query. Null when idle.
  const typeAhead = useRef<TypeAhead | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const palette = useMemo(() => {
    const release = () => {
      typeAhead.current = null;
      clearTimeout(releaseTimer.current);
    };
    const setOpen = (open: boolean) => {
      if (open && !openRef.current) {
        if (failedRef.current) {
          failedRef.current = false;
          setAttempt((n) => n + 1);
        }
        const session: TypeAhead = { text: '' };
        typeAhead.current = session;
        clearTimeout(releaseTimer.current);
        // Typing must never stay captured when the palette does not show up: released
        // if the chunk fails, or if the input has not taken it within the limit after
        // the chunk loaded (not after Cmd-K, so a slow network keeps a word whole).
        loadPalette().then(() => {
          if (typeAhead.current !== session) return;
          clearTimeout(releaseTimer.current);
          releaseTimer.current = setTimeout(release, TYPE_AHEAD_LIMIT_MS);
        }, release);
      }
      if (!open) release();
      openRef.current = open;
      if (open) setPaletteLoaded(true);
      setPaletteOpenState(open);
    };
    return {
      open: () => setOpen(true),
      setOpen,
      toggle: () => setOpen(!openRef.current),
      /** The chunk failed: close, release typing, and try a fresh load on the next open. */
      failed: () => {
        failedRef.current = true;
        setOpen(false);
      },
      takeTypeAhead: (): TypeAhead => {
        const typed = typeAhead.current ?? { text: '' };
        release();
        return { ...typed, text: typed.text.normalize('NFC') };
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
      else if (event.key === 'Backspace') typed.text = [...typed.text].slice(0, -1).join('');
      // Nothing to choose yet: remembered, and run on the first result for the typed text.
      else if (event.key === 'Enter') typed.enter = { alt: event.shiftKey || event.altKey };
      else if (isTyping(event)) {
        typed.text += event.key;
        typed.enter = undefined;
      } else if (!HELD_KEYS.has(event.key) || event.altKey || event.metaKey || event.ctrlKey) {
        // Modified arrows are navigation (Alt+Left is Back), not palette keys.
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    }
    function onPaste(event: ClipboardEvent) {
      const typed = typeAhead.current;
      if (typed === null) return;
      typed.text += (event.clipboardData?.getData('text') ?? '').replace(/\s+/g, ' ');
      event.preventDefault();
      event.stopPropagation();
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onTypeAhead, { capture: true });
    window.addEventListener('paste', onPaste, { capture: true });
    // Lets tests (and anything else) know global shortcuts are live.
    document.documentElement.dataset.shellReady = '';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onTypeAhead, { capture: true });
      window.removeEventListener('paste', onPaste, { capture: true });
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
          <ChunkBoundary key={attempt} fallback={null} onError={palette.failed}>
            <Suspense fallback={null}>
              {/* A new component only per load attempt, remounting after a failed chunk. */}
              {/* eslint-disable-next-line react-hooks/static-components */}
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
