import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { seg } from '../../../api/client';
import { useEdit } from '../../../api/edits';
import { apiSend } from '../../../api/client';
import { placesQuery } from '../../../api/queries';
import type { EventDetail } from '../../../api/types';
import { Button } from '../../../components/Button/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog/ConfirmDialog';
import { DateInput } from '../../../components/DateInput/DateInput';
import { Dialog, DialogClose } from '../../../components/Dialog/Dialog';
import { Input } from '../../../components/Input/Input';
import { Select } from '../../../components/Select/Select';
import { eventLabel } from '../../../lib/timeline';
import { removeEvent } from './optimistic';
import { useDirtyForm } from './dirty';
import { SaveError, useSaveState } from './SaveError';
import styles from './Edit.module.css';

/** Event types offered when adding; `EVEN` is a custom event with its own name. */
const EVENT_TYPES = [
  'BIRT',
  'CHR',
  'BAPM',
  'DEAT',
  'BURI',
  'CREM',
  'RESI',
  'OCCU',
  'EDUC',
  'CENS',
  'EMIG',
  'IMMI',
  'NATU',
  'MILI',
  'RELI',
  'RETI',
  'GRAD',
  'PROB',
  'WILL',
  'MARR',
  'DIV',
  'EVEN',
];

/** Wait after the last key in Place before asking for suggestions. */
const PLACE_SUGGEST_DELAY_MS = 150;

/** Types whose main detail is a value (`Occupation: Blacksmith`). */
const VALUE_LABELS: Record<string, string> = {
  OCCU: 'Occupation',
  TITL: 'Title',
  RELI: 'Religion',
  NATI: 'Nationality',
  EDUC: 'School or degree',
  PROP: 'Property',
  DSCR: 'Description',
};

interface EventDialogProps {
  tree: string;
  personId: string;
  /** The event to edit; omit to add a new person event. */
  item?: EventDetail | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes on close if the opener is gone (the event was deleted). */
  returnFocusFallback?: () => HTMLElement | null | undefined;
}

/** Add or edit an event: type, date with the parser's live preview, place and details. */
export function EventDialog({
  tree,
  personId,
  item,
  open,
  onOpenChange,
  returnFocusFallback,
}: EventDialogProps) {
  const base = `/trees/${seg(tree)}`;
  const edit = useEdit(tree);
  // Stays open until the save succeeds, so a failure keeps the fields.
  const saveState = useSaveState(() => onOpenChange(false));
  const event = item?.event;
  // No default type when adding: a silent Birth made second births by accident (#280).
  const [type, setType] = useState(event?.type ?? '');
  const [typeError, setTypeError] = useState<string | undefined>();
  const [customType, setCustomType] = useState(event?.custom_type ?? '');
  const [date, setDate] = useState(event?.date_text ?? '');
  const [place, setPlace] = useState(item?.place?.full_name ?? '');
  // Existing places matching what is typed, so the event reuses one instead of adding a near
  // twin. Asked 150 ms after the last key, so a fast typist sends one request, not one per key.
  const [typedPlace, setTypedPlace] = useState(place.trim());
  useEffect(() => {
    const id = setTimeout(() => setTypedPlace(place.trim()), PLACE_SUGGEST_DELAY_MS);
    return () => clearTimeout(id);
  }, [place]);
  const places = useQuery({
    ...placesQuery(tree, typedPlace),
    enabled: open && typedPlace.length >= 2,
    placeholderData: keepPreviousData,
  });
  const placeSuggestions =
    place.trim().length >= 2 ? (places.data ?? []).map((p) => p.full_name) : [];
  const [detail, setDetail] = useState(
    (event && (VALUE_LABELS[event.type] ? event.value : event.description)) ?? '',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  useDirtyForm({ type, customType, date, place, detail });
  const types =
    event && !EVENT_TYPES.includes(event.type) ? [...EVENT_TYPES, event.type] : EVENT_TYPES;
  const label = eventLabel(type, customType);

  function save() {
    if (edit.isPending) return;
    if (!type) {
      setTypeError('Choose an event type');
      return;
    }
    const valueField = VALUE_LABELS[type] ? 'value' : 'description';
    const body = {
      type,
      custom_type: type === 'EVEN' ? customType.trim() || null : null,
      date_text: date.trim() || null,
      place: place.trim() || null,
      [valueField]: detail.trim() || null,
    };
    edit.mutate(
      event
        ? {
            label: `Edit ${label}`,
            send: () => apiSend('PATCH', `${base}/events/${event.id}`, body),
            ...saveState.handlers(),
          }
        : {
            label: `Add ${label}`,
            send: () => apiSend('POST', `${base}/people/${personId}/events`, body),
            ...saveState.handlers(),
          },
    );
  }

  function deleteEvent() {
    if (!event) return;
    onOpenChange(false);
    edit.mutate({
      label: `Delete ${label}`,
      optimistic: { personId, update: (current) => removeEvent(current, event.id) },
      send: () => apiSend('DELETE', `${base}/events/${event.id}`),
    });
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={event ? 'Edit event' : 'Add event'}
        {...(returnFocusFallback ? { returnFocusFallback } : {})}
        footer={
          <div className={styles.footer}>
            {event && (
              <Button
                variant="danger"
                iconStart={<Trash2 size={16} aria-hidden />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete event
              </Button>
            )}
            <span className={styles.spacer} />
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="primary" onClick={save} loading={edit.isPending}>
              {saveState.submitLabel('Save')}
            </Button>
          </div>
        }
      >
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className={styles.grid}>
            <Select
              label="Event type"
              value={type}
              onValueChange={(value) => {
                setType(value);
                setTypeError(undefined);
              }}
              placeholder="Choose a type"
              error={typeError}
              options={types.map((t) => ({
                value: t,
                label: t === 'EVEN' ? 'Custom event' : eventLabel(t),
              }))}
            />
            {type === 'EVEN' && (
              <Input
                label="Event name"
                value={customType}
                onChange={(e) => setCustomType(e.currentTarget.value)}
              />
            )}
          </div>
          <DateInput label="Date" value={date} onValueChange={setDate} />
          <Input
            label="Place"
            value={place}
            onChange={(e) => setPlace(e.currentTarget.value)}
            suggestions={placeSuggestions}
            hint="Smallest to largest, e.g. Wexmoor, Westmere, England"
          />
          <Input
            label={VALUE_LABELS[type] ?? 'Description'}
            value={detail}
            onChange={(e) => setDetail(e.currentTarget.value)}
          />
          <SaveError error={saveState.error} />
          <button type="submit" hidden />
        </form>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete this ${label.toLowerCase()} event?`}
        description="Sources and notes attached to it are unlinked. You can undo this."
        confirmLabel="Delete event"
        onConfirm={deleteEvent}
      />
    </>
  );
}
