import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import buttonStyles from '../components/Button/Button.module.css';
import { Button } from '../components/Button/Button';
import { Checkbox } from '../components/Checkbox/Checkbox';
import { Dialog, DialogClose } from '../components/Dialog/Dialog';
import { Select } from '../components/Select/Select';
import { cx } from '../lib/cx';
import { EXPORT_FORMATS, canPrivatize, exportUrl, type ExportFormat } from '../lib/exportUrl';
import styles from './ExportDialog.module.css';

interface TreeInfo {
  id: string;
  name: string;
}

async function fetchTrees(): Promise<TreeInfo[]> {
  const res = await fetch('/api/trees');
  if (!res.ok) throw new Error(`Could not list trees (${res.status})`);
  return ((await res.json()) as { trees: TreeInfo[] }).trees;
}

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focus target on close; the menu item that opened the dialog is gone by then. */
  returnFocus?: () => void;
}

/** Choose a tree, a format and whether to privatize living people, then download. */
export function ExportDialog({ open, onOpenChange, returnFocus }: ExportDialogProps) {
  const trees = useQuery({ queryKey: ['trees'], queryFn: fetchTrees, enabled: open });
  const [tree, setTree] = useState<string | undefined>();
  const [format, setFormat] = useState<ExportFormat>('gedcom-5.5.1');
  const [privatize, setPrivatize] = useState(false);
  const list = trees.data ?? [];
  const selected = tree ?? (list.length === 1 ? list[0]!.id : undefined);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Export tree"
      description="Download a copy to back up or to open in other family tree software."
      size="sm"
      onCloseAutoFocus={(event) => {
        if (!returnFocus) return;
        event.preventDefault();
        returnFocus();
      }}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          {selected ? (
            <a
              className={cx(buttonStyles.button, buttonStyles.primary, buttonStyles.md)}
              href={exportUrl(selected, format, privatize)}
              download
              onClick={() => onOpenChange(false)}
            >
              <Download size={16} aria-hidden />
              Export
            </a>
          ) : (
            <Button variant="primary" disabled iconStart={<Download size={16} aria-hidden />}>
              Export
            </Button>
          )}
        </>
      }
    >
      <div className={styles.fields}>
        <Select
          label="Tree"
          options={list.map((t) => ({ value: t.id, label: t.name }))}
          value={selected}
          onValueChange={setTree}
          placeholder={trees.isPending ? 'Loading trees…' : 'Choose a tree'}
          error={
            trees.isError
              ? 'Could not load your trees.'
              : trees.isSuccess && list.length === 0
                ? 'There are no trees to export yet.'
                : undefined
          }
        />
        <Select
          label="Format"
          options={EXPORT_FORMATS}
          value={format}
          onValueChange={(value) => setFormat(value as ExportFormat)}
        />
        <Checkbox
          label="Privatize living people"
          description={
            canPrivatize(format)
              ? 'Living people are written as "Private" with only their family links.'
              : 'JSON is a full backup and always includes everyone.'
          }
          checked={privatize && canPrivatize(format)}
          disabled={!canPrivatize(format)}
          onChange={(event) => setPrivatize(event.target.checked)}
        />
      </div>
    </Dialog>
  );
}
