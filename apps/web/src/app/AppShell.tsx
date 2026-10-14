import { lazy, Suspense, useEffect, useState } from 'react';
import { Outlet } from '@tanstack/react-router';
import { ToastProvider } from '../components/Toast/Toast';
import { TopBar } from './TopBar';
import styles from './AppShell.module.css';

const loadPalette = () => import('./ShellCommandPalette');
const ShellCommandPalette = lazy(loadPalette);

/** Cmd on macOS, Ctrl elsewhere; both work everywhere. */
function isPaletteShortcut(event: KeyboardEvent) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k';
}

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The palette chunk loads on first use, then stays mounted so it opens instantly.
  const [paletteLoaded, setPaletteLoaded] = useState(false);

  const openPalette = () => {
    setPaletteLoaded(true);
    setPaletteOpen(true);
  };

  // Fetch the palette chunk once the page is idle so Cmd-K never waits on the network.
  useEffect(() => {
    const id = setTimeout(() => void loadPalette(), 1500);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      setPaletteLoaded(true);
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
    <ToastProvider>
      <a className={styles.skipLink} href="#main">
        Skip to content
      </a>
      <TopBar onFind={openPalette} />
      <main id="main" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
      {paletteLoaded && (
        <Suspense fallback={null}>
          <ShellCommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        </Suspense>
      )}
    </ToastProvider>
  );
}
