import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { FileUp } from 'lucide-react';
import { Button } from '../../components/Button/Button';
import { IMPORT_ACCEPT } from '../../library/api';
import { useImportFile } from '../../library/useImportFile';
import styles from './Import.module.css';

/**
 * Accepts a GEDCOM or GEDZIP by drag and drop anywhere in the zone, or through
 * the file picker behind the "Import GEDCOM" button.
 */
export function ImportDropZone({ children }: { children?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const { importFile, error, busy } = useImportFile();
  // Counts nested dragenter/dragleave pairs so hovering child elements does not flicker.
  const [depth, setDepth] = useState(0);

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');

  return (
    <section
      aria-label="Import a file"
      className={styles.zone}
      data-dragging={depth > 0 ? 'true' : undefined}
      onDragEnter={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDepth((d) => d + 1);
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => setDepth((d) => Math.max(0, d - 1))}
      onDrop={(event) => {
        event.preventDefault();
        setDepth(0);
        void importFile(event.dataTransfer.files[0]);
      }}
    >
      <input
        ref={input}
        type="file"
        accept={IMPORT_ACCEPT}
        aria-label="Choose a GEDCOM or GEDZIP"
        // The "Import GEDCOM" button is the one control; this input is behind it.
        aria-hidden="true"
        className="oa-visually-hidden"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          void importFile(file);
        }}
      />
      <Button
        variant="primary"
        iconStart={<FileUp size={16} aria-hidden />}
        onClick={() => input.current?.click()}
        disabled={busy}
      >
        {busy ? 'Uploading…' : 'Import GEDCOM'}
      </Button>
      <p className={styles.hint}>or drop a .ged or GEDZIP (.zip, .gdz) file here</p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {children}
    </section>
  );
}
