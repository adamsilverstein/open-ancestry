import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CircleAlert } from 'lucide-react';
import { apiSend, seg } from '../api/client';
import { fieldError, friendlyMessage, useEdit, type FieldError } from '../api/edits';
import type { ApiPersonSummary } from '../api/types';
import { Button } from '../components/Button/Button';
import { Dialog, DialogClose } from '../components/Dialog/Dialog';
import { NewPersonFields, useNewPerson } from '../routes/person/edit/NewPersonFields';
import editStyles from '../routes/person/edit/Edit.module.css';

interface AddPersonDialogProps {
  tree: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus returns on close (Radix has no trigger to return to). */
  opener: HTMLElement | null;
}

/**
 * Adds a person who is not related to anyone yet: the first person in a new
 * tree, or the start of an unconnected branch. One undo step; opens them.
 */
export default function AddPersonDialog({
  tree,
  open,
  onOpenChange,
  opener,
}: AddPersonDialogProps) {
  const navigate = useNavigate();
  const edit = useEdit(tree);
  const draft = useNewPerson();
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<FieldError | null>(null);
  const saved = useRef(false);

  function save() {
    if (!draft.ready || edit.isPending) return;
    setError(null);
    setField(null);
    edit.mutate({
      label: 'Add person',
      send: () =>
        apiSend<{ person: ApiPersonSummary }>('POST', `/trees/${seg(tree)}/people`, draft.body()),
      onDone: ({ person }) => {
        saved.current = true;
        onOpenChange(false);
        void navigate({ to: '/person/$personId', params: { personId: person.id } });
      },
      // Keep the dialog and what was typed, so saving again is one click.
      onError: (cause) => {
        setField(fieldError(cause));
        setError(friendlyMessage(cause));
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add person"
      description="Someone not yet connected to anyone in this tree."
      onCloseAutoFocus={(event) => {
        // After a save the new person's page opens; otherwise return focus to
        // what opened the dialog (for the palette, what was focused before it).
        if (saved.current) return;
        const target = opener?.isConnected ? opener : document.getElementById('main');
        if (target) {
          event.preventDefault();
          target.focus();
        }
      }}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" onClick={save} disabled={!draft.ready || edit.isPending}>
            Add person
          </Button>
        </>
      }
    >
      <form
        className={editStyles.form}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <NewPersonFields draft={draft} errors={field ? { [field.field]: field.message } : {}} />
        {error && (
          <p role="alert" className={editStyles.error}>
            <CircleAlert size={14} aria-hidden />
            Could not add this person: {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
