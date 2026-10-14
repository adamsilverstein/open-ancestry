import buttonStyles from '../components/Button/Button.module.css';
import { cx } from '../lib/cx';
import styles from './TopBar.module.css';

/** Shared by the tree switcher and its placeholder, so nothing shifts when the menu loads. */
export const treeSwitcherClass = cx(
  buttonStyles.button,
  buttonStyles.ghost,
  buttonStyles.sm,
  styles.treeName,
);
