import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Download, TriangleAlert } from 'lucide-react';
import { Button } from '../components/Button/Button';
import { Checkbox } from '../components/Checkbox/Checkbox';
import { Dialog, DialogClose } from '../components/Dialog/Dialog';
import { Select } from '../components/Select/Select';
import { treeQuery } from '../api/queries';
import { currentTreeQuery, treesQuery } from '../library/api';
import {
  EXPORT_FORMATS,
  canPrivatize,
  downloadName,
  exportUrl,
  exportWarnings,
  type ExportFormat,
} from '../lib/exportUrl';
import styles from './ExportDialog.module.css';

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focus target on close; the menu item that opened the dialog is gone by then. */
  returnFocus?: () => void;
}

type ExportState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'error'; message: string }
  | { status: 'warned'; count: number; shown: string[] };

/** What an unprivatized export gives away, in words. */
function exposure(living: number, marked: number, json: boolean): string {
  const people = (n: number, what: string) => `${n} ${n === 1 ? 'person' : 'people'} ${what}`;
  const who = [
    living > 0 && people(living, 'who may be living'),
    marked > 0 && people(marked, 'marked private'),
  ]
    .filter(Boolean)
    .join(' and ');
  return json
    ? `JSON is a full backup: it includes everything about ${who}.`
    : `This export includes everything about ${who}.`;
}

/** Saves a downloaded body under `name` through a temporary object URL. */
function save(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/**
 * Choose a tree, a format and whether to privatize living people, then
 * download. The file is fetched rather than linked so the dialog can show
 * what the export could not carry over, or why it failed.
 */
export function ExportDialog({ open, onOpenChange, returnFocus }: ExportDialogProps) {
  const trees = useQuery({ ...treesQuery, enabled: open });
  const { data: current = null } = useQuery(currentTreeQuery);
  const [tree, setTree] = useState<string | undefined>();
  const [format, setFormat] = useState<ExportFormat>('gedcom-5.5.1');
  // Undefined until the user decides: then it follows the tree (on when anyone is hidden).
  const [choice, setChoice] = useState<boolean | undefined>();
  const [state, setState] = useState<ExportState>({ status: 'idle' });
  const list = trees.data ?? [];
  // The open tree by default, or the only one there is.
  const selected =
    tree ??
    (current && list.some((t) => t.id === current) ? current : undefined) ??
    (list.length === 1 ? list[0]!.id : undefined);
  const info = useQuery({ ...treeQuery(selected ?? ''), enabled: open && Boolean(selected) });
  const living = info.data?.livingCount ?? 0;
  const marked = info.data?.privateCount ?? 0;
  // Privatize by default whenever the tree has living or private people: safe unless asked.
  const privatize = canPrivatize(format) && (choice ?? living + marked > 0);

  const changeOpen = (next: boolean) => {
    if (!next) setState({ status: 'idle' });
    onOpenChange(next);
  };

  const download = async () => {
    if (!selected) return;
    setState({ status: 'busy' });
    try {
      const res = await fetch(exportUrl(selected, format, privatize));
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setState({
          status: 'error',
          message: body?.error?.message ?? `Export failed (${res.status})`,
        });
        return;
      }
      const extension = format === 'json' ? 'json' : format === 'gedzip' ? 'gdz' : 'ged';
      save(
        await res.blob(),
        downloadName(res.headers.get('content-disposition'), `${selected}.${extension}`),
      );
      const warnings = exportWarnings(res.headers);
      if (warnings.count) setState({ status: 'warned', ...warnings });
      else changeOpen(false);
    } catch {
      setState({ status: 'error', message: 'Export failed: the app could not reach the server.' });
    }
  };

  const warned = state.status === 'warned';
  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      title="Export tree"
      description="Download a copy to back up or to open in other family tree software."
      size="sm"
      onCloseAutoFocus={(event) => {
        if (!returnFocus) return;
        event.preventDefault();
        returnFocus();
      }}
      footer={
        warned ? (
          <DialogClose asChild>
            <Button variant="primary">Done</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant="primary"
              disabled={!selected}
              loading={state.status === 'busy'}
              iconStart={<Download size={16} aria-hidden />}
              onClick={download}
            >
              Export
            </Button>
          </>
        )
      }
    >
      {warned ? (
        <div className={styles.result} role="status">
          <p className={styles.warning}>
            <TriangleAlert size={16} aria-hidden />
            Exported. {state.count === 1 ? '1 imported line' : `${state.count} imported lines`}{' '}
            could not be carried over:
          </p>
          <ul className={styles.list}>
            {state.shown.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
          {state.count > state.shown.length && (
            <p className={styles.more}>and {state.count - state.shown.length} more.</p>
          )}
        </div>
      ) : (
        <div className={styles.fields}>
          <Select
            label="Tree"
            options={list.map((t) => ({ value: t.id, label: t.name }))}
            value={selected}
            onValueChange={(id) => {
              setTree(id);
              setChoice(undefined);
            }}
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
            label="Privatize living and private people"
            description={
              canPrivatize(format)
                ? 'Living people, and anyone marked private, confidential or locked, are written as "Private" with only their family links.'
                : 'JSON is a full backup and always includes everyone.'
            }
            checked={privatize}
            disabled={!canPrivatize(format)}
            onChange={(event) => setChoice(event.target.checked)}
          />
          {!privatize && living + marked > 0 && (
            <p className={styles.warning} role="status">
              <TriangleAlert size={16} aria-hidden />
              {exposure(living, marked, format === 'json')}
            </p>
          )}
          {state.status === 'error' && (
            <p className={styles.error} role="alert">
              <CircleAlert size={16} aria-hidden />
              {state.message}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
