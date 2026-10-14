import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CircleAlert } from 'lucide-react';
import { apiSend, seg } from '../api/client';
import { useEdit } from '../api/edits';
import type { ApiPersonSummary } from '../api/types';
import { Button } from '../components/Button/Button';
import { Dialog, DialogClose } from '../components/Dialog/Dialog';
import { NewPersonFields, useNewPerson } from '../routes/person/edit/NewPersonFields';
import editStyles from '../routes/person/edit/Edit.module.css';

interface AddPersonDialogProps {
  tree: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Adds a person who is not related to anyone yet: the first person in a new
 * tree, or the start of an unconnected branch. One undo step; opens them.
 */
export default function AddPersonDialog({ tree, open, onOpenChange }: AddPersonDialogProps) {
  const navigate = useNavigate();
  const edit = useEdit(tree);
  const draft = useNewPerson();
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  function save() {
    if (!draft.ready || edit.isPending) return;
    setError(null);
    edit.mutate({
      label: 'Add person',
      send: () =>
        apiSend<{ person: ApiPersonSummary }>('POST', `/trees/${seg(tree)}/people`, draft.body()),
      onDone: ({ person }) => {
        opener.current = null;
        onOpenChange(false);
        void navigate({ to: '/person/$personId', params: { personId: person.id } });
      },
      // Keep the dialog and what was typed, so saving again is one click.
      onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add person"
      description="Someone not yet connected to anyone in this tree."
      onOpenAutoFocus={() => {
        opener.current = document.activeElement as HTMLElement | null;
      }}
      onCloseAutoFocus={(event) => {
        // No trigger element: return focus to whatever opened the dialog, if still on the page.
        if (opener.current?.isConnected) {
          event.preventDefault();
          opener.current.focus();
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
        <NewPersonFields draft={draft} />
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
