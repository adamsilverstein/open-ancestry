import { useEffect, useRef, useState } from 'react';
import { NotebookPen, Pencil, Plus, Trash2 } from 'lucide-react';
import type { NoteRow } from '@open-ancestry/db';
import { seg } from '../../../api/client';
import { useEdit } from '../../../api/edits';
import { apiSend } from '../../../api/client';
import type { PersonDetail } from '../../../api/types';
import { Button } from '../../../components/Button/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog/ConfirmDialog';
import { EmptyState } from '../../../components/EmptyState/EmptyState';
import { IconButton } from '../../../components/IconButton/IconButton';
import { Panel } from '../../../components/Panel/Panel';
import { Textarea } from '../../../components/Textarea/Textarea';
import { eventLabel } from '../../../lib/timeline';
import pageStyles from '../PersonPage.module.css';
import { removeNote, setNoteText } from './optimistic';
import { SaveError, useSaveState } from './SaveError';
import { useDirtyForm } from './dirty';
import styles from './Edit.module.css';

function NoteForm({
  label,
  initial,
  onSave,
  onCancel,
  pending,
  error,
}: {
  label: string;
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  pending: boolean;
  /** Why the last save failed; the form stays open with the text. */
  error: string | null;
}) {
  const [text, setText] = useState(initial);
  useDirtyForm(text);
  const field = useRef<HTMLTextAreaElement>(null);
  // Focus the field the user just asked to write in.
  useEffect(() => field.current?.focus(), []);
  return (
    <form
      className={styles.noteForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() && !pending) onSave(text);
      }}
    >
      <Textarea
        label={label}
        value={text}
        ref={field}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      <SaveError error={error} />
      <div className={styles.row}>
        <Button type="submit" size="sm" variant="primary" disabled={!text.trim()} loading={pending}>
          {error ? 'Try again' : 'Save note'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Person and event notes, with add, edit and delete. */
export function NotesTab({ tree, detail }: { tree: string; detail: PersonDetail }) {
  const id = detail.person.id;
  const base = `/trees/${seg(tree)}`;
  const edit = useEdit(tree);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<NoteRow | null>(null);
  // A note form closes only once its save succeeds, so a failure keeps the text.
  const saveState = useSaveState(() => {
    setAdding(false);
    setEditing(null);
  });
  const notes = [
    ...detail.notes.map((note) => ({ note, about: null as string | null })),
    ...detail.events.flatMap(({ event, notes: eventNotes }) =>
      eventNotes.map((note) => ({ note, about: eventLabel(event.type, event.custom_type) })),
    ),
  ];

  const save = (note: NoteRow, text: string) => {
    edit.mutate({
      label: 'Edit note',
      optimistic: { personId: id, update: (d) => setNoteText(d, note.id, text) },
      send: () => apiSend('PATCH', `${base}/notes/${note.id}`, { text }),
      ...saveState.handlers(),
    });
  };

  return (
    <div className={pageStyles.readable}>
      {adding ? (
        <NoteForm
          label="New note"
          initial=""
          onCancel={() => setAdding(false)}
          pending={edit.isPending}
          error={saveState.error}
          onSave={(text) => {
            edit.mutate({
              label: 'Add note',
              send: () =>
                apiSend('POST', `${base}/notes`, { text, owner_type: 'person', owner_id: id }),
              ...saveState.handlers(),
            });
          }}
        />
      ) : (
        <div>
          <Button
            size="sm"
            iconStart={<Plus size={14} aria-hidden />}
            onClick={() => {
              saveState.reset();
              setAdding(true);
            }}
          >
            Add note
          </Button>
        </div>
      )}
      {notes.length === 0 && !adding && (
        <EmptyState icon={<NotebookPen size={24} aria-hidden />} title="No notes yet" />
      )}
      {notes.map(({ note, about }) => (
        <Panel
          key={`${about}:${note.id}`}
          title={about ? `Note on ${about}` : undefined}
          headingLevel={2}
          actions={
            editing === note.id ? undefined : (
              <>
                <IconButton
                  label="Edit note"
                  size="sm"
                  icon={<Pencil size={14} aria-hidden />}
                  onClick={() => {
                    saveState.reset();
                    setEditing(note.id);
                  }}
                />
                <IconButton
                  label="Delete note"
                  size="sm"
                  icon={<Trash2 size={14} aria-hidden />}
                  onClick={() => setDeleting(note)}
                />
              </>
            )
          }
        >
          {editing === note.id ? (
            <NoteForm
              label="Note"
              initial={note.text}
              onCancel={() => setEditing(null)}
              pending={edit.isPending}
              error={saveState.error}
              onSave={(text) => save(note, text)}
            />
          ) : (
            <p className={pageStyles.noteText}>{note.text}</p>
          )}
        </Panel>
      ))}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this note?"
        description="You can undo this."
        confirmLabel="Delete note"
        onConfirm={() => {
          const note = deleting!;
          edit.mutate({
            label: 'Delete note',
            optimistic: { personId: id, update: (d) => removeNote(d, note.id) },
            send: () => apiSend('DELETE', `${base}/notes/${note.id}`),
          });
        }}
      />
    </div>
  );
}
