import { lazy, Suspense } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown, Moon, Search, Sun, TreeDeciduous, Users } from 'lucide-react';
import { Button } from '../components/Button/Button';
import buttonStyles from '../components/Button/Button.module.css';
import { IconButtonBase } from '../components/IconButton/IconButtonBase';
import { cx } from '../lib/cx';
import { useTheme } from '../lib/useTheme';
import styles from './TopBar.module.css';
import { treeSwitcherClass } from './treeSwitcherClass';

const FileMenu = lazy(() => import('./FileMenu'));
const TreeSwitcher = lazy(() => import('./TreeSwitcher'));

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Same look as the real trigger while the menu chunk loads, so nothing shifts. */
function FileMenuPlaceholder() {
  return (
    <button
      type="button"
      className={cx(buttonStyles.button, buttonStyles.ghost, buttonStyles.sm)}
      aria-disabled="true"
    >
      File
      <ChevronDown size={14} aria-hidden />
    </button>
  );
}

function TreeSwitcherPlaceholder() {
  return (
    <button
      type="button"
      className={treeSwitcherClass}
      aria-disabled="true"
      aria-label="Tree: loading"
    >
      <span>Trees</span>
      <ChevronDown size={14} aria-hidden />
    </button>
  );
}

export function TopBar({ onFind }: { onFind: () => void }) {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <header className={styles.topBar}>
      <Link to="/" className={styles.brand} aria-label="open-ancestry home">
        <TreeDeciduous size={20} aria-hidden />
        <span aria-hidden>open-ancestry</span>
      </Link>
      <span className={styles.divider} aria-hidden />
      <Suspense fallback={<TreeSwitcherPlaceholder />}>
        <TreeSwitcher />
      </Suspense>

      <div className={styles.actions}>
        <Link
          to="/people"
          className={cx(buttonStyles.button, buttonStyles.ghost, buttonStyles.sm, styles.find)}
          activeProps={{ 'aria-current': 'page' }}
        >
          <Users size={16} aria-hidden />
          People
        </Link>
        <Button
          size="sm"
          variant="ghost"
          className={styles.find}
          iconStart={<Search size={16} aria-hidden />}
          onClick={onFind}
          aria-keyshortcuts="Meta+K Control+K"
        >
          Find
          <kbd className={styles.kbd}>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </Button>
        <Suspense fallback={<FileMenuPlaceholder />}>
          <FileMenu />
        </Suspense>
        <IconButtonBase
          label={`Switch to ${next} theme`}
          title={`Switch to ${next} theme`}
          icon={theme === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
          onClick={toggle}
        />
      </div>
    </header>
  );
}
