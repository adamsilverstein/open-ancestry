import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { apiSend, seg } from '../api/client';
import { useEdit } from '../api/edits';
import type { ApiPersonSummary } from '../api/types';
import { Button } from '../components/Button/Button';
import { Dialog, DialogClose } from '../components/Dialog/Dialog';
import { NewPersonFields, useNewPerson } from '../routes/person/edit/NewPersonFields';
import { SaveError, useSaveState } from '../routes/person/edit/SaveError';
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
  const saved = useRef(false);
  // The dialog stays mounted after Cancel, so a save that lands later must not
  // open the person (or close a dialog reopened since).
  const isOpen = useRef(open);
  useEffect(() => {
    isOpen.current = open;
  }, [open]);
  // Stays open until the save succeeds, so a failure keeps what was typed.
  const saveState = useSaveState<{ person: ApiPersonSummary }>((result) => {
    if (!isOpen.current) return;
    // No result: the tree was removed elsewhere, so there is no one to open.
    if (!result) return onOpenChange(false);
    saved.current = true;
    onOpenChange(false);
    void navigate({ to: '/person/$personId', params: { personId: result.person.id } });
  });

  function save() {
    if (!draft.ready || edit.isPending) return;
    edit.mutate({
      label: 'Add person',
      send: () =>
        apiSend<{ person: ApiPersonSummary }>('POST', `/trees/${seg(tree)}/people`, draft.body()),
      ...saveState.handlers(),
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
          <Button variant="primary" onClick={save} disabled={!draft.ready} loading={edit.isPending}>
            {saveState.submitLabel('Add person')}
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
        <NewPersonFields
          draft={draft}
          errors={saveState.field ? { [saveState.field.field]: saveState.field.message } : {}}
        />
        <SaveError error={saveState.error} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
