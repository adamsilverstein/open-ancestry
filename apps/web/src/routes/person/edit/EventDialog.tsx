import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { seg } from '../../../api/client';
import { useEdit } from '../../../api/edits';
import { apiSend } from '../../../api/mutations';
import type { EventDetail } from '../../../api/types';
import { Button } from '../../../components/Button/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog/ConfirmDialog';
import { DateInput } from '../../../components/DateInput/DateInput';
import { Dialog, DialogClose } from '../../../components/Dialog/Dialog';
import { Input } from '../../../components/Input/Input';
import { Select } from '../../../components/Select/Select';
import { eventLabel } from '../../../lib/timeline';
import { removeEvent } from './optimistic';
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
}

/** Add or edit an event: type, date with the parser's live preview, place and details. */
export function EventDialog({ tree, personId, item, open, onOpenChange }: EventDialogProps) {
  const base = `/trees/${seg(tree)}`;
  const edit = useEdit(tree);
  const event = item?.event;
  const [type, setType] = useState(event?.type ?? 'BIRT');
  const [customType, setCustomType] = useState(event?.custom_type ?? '');
  const [date, setDate] = useState(event?.date_text ?? '');
  const [place, setPlace] = useState(item?.place?.full_name ?? '');
  const [detail, setDetail] = useState(
    (event && (VALUE_LABELS[event.type] ? event.value : event.description)) ?? '',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const types =
    event && !EVENT_TYPES.includes(event.type) ? [...EVENT_TYPES, event.type] : EVENT_TYPES;
  const label = eventLabel(type, customType);

  function save() {
    const valueField = VALUE_LABELS[type] ? 'value' : 'description';
    const body = {
      type,
      custom_type: type === 'EVEN' ? customType.trim() || null : null,
      date_text: date.trim() || null,
      place: place.trim() || null,
      [valueField]: detail.trim() || null,
    };
    onOpenChange(false);
    edit.mutate(
      event
        ? {
            label: `Edit ${label}`,
            send: () => apiSend('PATCH', `${base}/events/${event.id}`, body),
          }
        : {
            label: `Add ${label}`,
            send: () => apiSend('POST', `${base}/people/${personId}/events`, body),
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
            <Button variant="primary" onClick={save}>
              Save
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
              onValueChange={setType}
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
            hint="Smallest to largest, e.g. Wexmoor, Westmere, England"
          />
          <Input
            label={VALUE_LABELS[type] ?? 'Description'}
            value={detail}
            onChange={(e) => setDetail(e.currentTarget.value)}
          />
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
