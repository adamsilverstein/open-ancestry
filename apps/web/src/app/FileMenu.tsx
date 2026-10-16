import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FileDown, FileUp, RefreshCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import buttonStyles from '../components/Button/Button.module.css';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../components/Menu/Menu';
import { useToast } from '../components/Toast/Toast';
import {
  BAD_FILE_MESSAGE,
  IMPORT_ACCEPT,
  currentTreeQuery,
  hasImportExtension,
} from '../library/api';
import { startReimport } from '../routes/reimport/api';
import { useImportFile } from '../library/useImportFile';
import { cx } from '../lib/cx';
import { ExportDialog } from './ExportDialog';

export const fileMenuTriggerClass = cx(buttonStyles.button, buttonStyles.ghost, buttonStyles.sm);

/** Import and export entry points. Lazy loaded: the menu library is not on the initial bundle. */
export default function FileMenu() {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [exporting, setExporting] = useState(false);
  const { importFile, error } = useImportFile();
  const reimportInput = useRef<HTMLInputElement>(null);
  const { data: tree = null } = useQuery(currentTreeQuery);
  const navigate = useNavigate();

  async function reimport(file: File | undefined) {
    if (!file || !tree) return;
    if (!hasImportExtension(file.name)) {
      toast({ title: 'Re-import did not start', description: BAD_FILE_MESSAGE, variant: 'error' });
      return;
    }
    try {
      const { jobId } = await startReimport(tree, file);
      await navigate({ to: '/reimport/$jobId', params: { jobId } });
    } catch (cause) {
      toast({
        title: 'Re-import did not start',
        description: cause instanceof Error ? cause.message : String(cause),
        variant: 'error',
      });
    }
  }

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
      <input
        ref={reimportInput}
        type="file"
        accept={IMPORT_ACCEPT}
        aria-hidden="true"
        tabIndex={-1}
        className="oa-visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          void reimport(file);
        }}
      />
      <Menu>
        <MenuTrigger ref={trigger} className={fileMenuTriggerClass}>
          File
          <ChevronDown size={14} aria-hidden />
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={() => input.current?.click()}>
            <FileUp size={16} aria-hidden />
            Import GEDCOM…
          </MenuItem>
          <MenuItem disabled={!tree} onSelect={() => reimportInput.current?.click()}>
            <RefreshCw size={16} aria-hidden />
            Re-import updated export…
          </MenuItem>
          <MenuItem disabled={!tree} onSelect={() => setExporting(true)}>
            <FileDown size={16} aria-hidden />
            Export…
          </MenuItem>
          {!tree && (
            <>
              <MenuSeparator />
              {/* Disabled items cannot say why on their own (#280). */}
              <MenuItem disabled>Re-import and export need a tree. Import a GEDCOM first.</MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
      <ExportDialog
        open={exporting}
        onOpenChange={setExporting}
        returnFocus={() => trigger.current?.focus()}
      />
    </>
  );
}
