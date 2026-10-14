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
import styles from './Edit.module.css';

function NoteForm({
  label,
  initial,
  onSave,
  onCancel,
}: {
  label: string;
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  // Focus the field the user just asked to write in.
  useEffect(() => field.current?.focus(), []);
  return (
    <form
      className={styles.noteForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSave(text);
      }}
    >
      <Textarea
        label={label}
        value={text}
        ref={field}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      <div className={styles.row}>
        <Button type="submit" size="sm" variant="primary" disabled={!text.trim()}>
          Save note
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
  const notes = [
    ...detail.notes.map((note) => ({ note, about: null as string | null })),
    ...detail.events.flatMap(({ event, notes: eventNotes }) =>
      eventNotes.map((note) => ({ note, about: eventLabel(event.type, event.custom_type) })),
    ),
  ];

  const save = (note: NoteRow, text: string) => {
    setEditing(null);
    edit.mutate({
      label: 'Edit note',
      optimistic: { personId: id, update: (d) => setNoteText(d, note.id, text) },
      send: () => apiSend('PATCH', `${base}/notes/${note.id}`, { text }),
    });
  };

  return (
    <div className={pageStyles.readable}>
      {adding ? (
        <NoteForm
          label="New note"
          initial=""
          onCancel={() => setAdding(false)}
          onSave={(text) => {
            setAdding(false);
            edit.mutate({
              label: 'Add note',
              send: () =>
                apiSend('POST', `${base}/notes`, { text, owner_type: 'person', owner_id: id }),
            });
          }}
        />
      ) : (
        <div>
          <Button
            size="sm"
            iconStart={<Plus size={14} aria-hidden />}
            onClick={() => setAdding(true)}
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
                  onClick={() => setEditing(note.id)}
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
