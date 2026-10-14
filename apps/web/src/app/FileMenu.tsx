import { useEffect, useRef } from 'react';
import { ChevronDown, FileDown, FileUp } from 'lucide-react';
import buttonStyles from '../components/Button/Button.module.css';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../components/Menu/Menu';
import { useToast } from '../components/Toast/Toast';
import { IMPORT_ACCEPT } from '../library/api';
import { useImportFile } from '../library/useImportFile';
import { cx } from '../lib/cx';

export const fileMenuTriggerClass = cx(buttonStyles.button, buttonStyles.ghost, buttonStyles.sm);

/** Import and export entry points. Lazy loaded: the menu library is not on the initial bundle. */
export default function FileMenu() {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const { importFile, error } = useImportFile();

  useEffect(() => {
    if (error) toast({ title: 'Import did not start', description: error, variant: 'error' });
  }, [error, toast]);

  return (
    <>
      {/* Outside the menu content, which unmounts when the menu closes. */}
      <input
        ref={input}
        type="file"
        accept={IMPORT_ACCEPT}
        aria-hidden="true"
        tabIndex={-1}
        className="oa-visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          void importFile(file);
        }}
      />
      <Menu>
        <MenuTrigger className={fileMenuTriggerClass}>
          File
          <ChevronDown size={14} aria-hidden />
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={() => input.current?.click()}>
            <FileUp size={16} aria-hidden />
            Import GEDCOM…
          </MenuItem>
          <MenuItem disabled>
            <FileDown size={16} aria-hidden />
            Export GEDCOM…
          </MenuItem>
        </MenuContent>
      </Menu>
    </>
  );
}
