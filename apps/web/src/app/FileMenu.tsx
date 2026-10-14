import { ChevronDown, FileDown, FileUp } from 'lucide-react';
import buttonStyles from '../components/Button/Button.module.css';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../components/Menu/Menu';
import { useToast } from '../components/Toast/Toast';
import { cx } from '../lib/cx';

export const fileMenuTriggerClass = cx(buttonStyles.button, buttonStyles.ghost, buttonStyles.sm);

/** Import and export entry points. Lazy loaded: the menu library is not on the initial bundle. */
export default function FileMenu() {
  const toast = useToast();
  return (
    <Menu>
      <MenuTrigger className={fileMenuTriggerClass}>
        File
        <ChevronDown size={14} aria-hidden />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem onSelect={() => toast({ title: 'Import is coming soon' })}>
          <FileUp size={16} aria-hidden />
          Import GEDCOM…
        </MenuItem>
        <MenuItem disabled>
          <FileDown size={16} aria-hidden />
          Export GEDCOM…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
