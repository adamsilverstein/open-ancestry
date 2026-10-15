import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import type {
  ChildRelationship,
  LivingStatus,
  NameType,
  RelationshipType,
  Sex,
} from '@open-ancestry/db';
import { seg } from '../../../api/client';
import { useEdit } from '../../../api/edits';
import { ApiError, apiSend } from '../../../api/client';
import { rememberDeletedPerson, undoRedo } from '../../../api/history';
import { personQuery } from '../../../api/queries';
import type { PersonDetail } from '../../../api/types';
import { Button } from '../../../components/Button/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog/ConfirmDialog';
import { Dialog, DialogClose } from '../../../components/Dialog/Dialog';
import { IconButton } from '../../../components/IconButton/IconButton';
import { Input } from '../../../components/Input/Input';
import { Select } from '../../../components/Select/Select';
import { useToast } from '../../../components/Toast/Toast';
import { fullName, isLivingStatus, nearestRelative } from '../../../lib/person';
import { useOpenRestored } from '../../../lib/useOpenRestored';
import { applyNames, applyPerson, nameChanges, toDraft, type NameDraft } from './optimistic';
import { useDirtyForm } from './dirty';
import { SaveError, useSaveState } from './SaveError';
import styles from './Edit.module.css';

export const NAME_TYPES: { value: NameType; label: string }[] = [
  { value: 'birth', label: 'Birth name' },
  { value: 'married', label: 'Married name' },
  { value: 'maiden', label: 'Maiden name' },
  { value: 'aka', label: 'Also known as' },
  { value: 'immigrant', label: 'Immigrant name' },
  { value: 'professional', label: 'Professional name' },
  { value: 'religious', label: 'Religious name' },
  { value: 'other', label: 'Other name' },
];

export const SEX_OPTIONS: { value: Sex; label: string }[] = [
  { value: 'M', label: 'Male' },
  { value: 'F', label: 'Female' },
  { value: 'X', label: 'Other' },
  { value: 'U', label: 'Unknown' },
];

export const RELATIONSHIP_TYPES: { value: RelationshipType; label: string }[] = [
  { value: 'married', label: 'Married' },
  { value: 'civil_union', label: 'Civil union' },
  { value: 'partners', label: 'Partners' },
  { value: 'unknown', label: 'Unknown' },
];

/** Shown under a partnership in Relationships; unknown says nothing. */
export const relationshipTypeLabel = (type: RelationshipType): string | undefined =>
  type === 'unknown' ? undefined : RELATIONSHIP_TYPES.find((t) => t.value === type)?.label;

export const CHILD_RELATIONSHIPS: { value: ChildRelationship; label: string }[] = [
  { value: 'biological', label: 'Biological' },
  { value: 'adopted', label: 'Adopted' },
  { value: 'step', label: 'Step' },
  { value: 'foster', label: 'Foster' },
  { value: 'related', label: 'Related' },
  { value: 'guardian', label: 'Guardian' },
  { value: 'unknown', label: 'Unknown' },
];

type LivingChoice = 'infer' | 'living' | 'dead';

function livingChoice(status: LivingStatus): LivingChoice {
  return status === 'living' ? 'living' : status === 'dead' ? 'dead' : 'infer';
}

interface ParentLink {
  linkId: string;
  slot: 'partner1_rel' | 'partner2_rel';
  parentName: string;
  rel: ChildRelationship;
}

function parentLinks(detail: PersonDetail): ParentLink[] {
  return detail.parentFamilies.flatMap((family) =>
    (
      [
        [family.partner1, 'partner1_rel'],
        [family.partner2, 'partner2_rel'],
      ] as const
    ).flatMap(([parent, slot]) =>
      parent
        ? [{ linkId: family.link.id, slot, parentName: fullName(parent), rel: family.link[slot] }]
        : [],
    ),
  );
}

const blankName = (): NameDraft => ({
  type: 'aka',
  prefix: '',
  given: '',
  surname: '',
  suffix: '',
  nickname: '',
  isPrimary: false,
});

interface EditPersonDialogProps {
  tree: string;
  detail: PersonDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Names (all types), sex, living status, relationship to each parent, and delete. */
export function EditPersonDialog({ tree, detail, open, onOpenChange }: EditPersonDialogProps) {
  const id = detail.person.id;
  const base = `/trees/${seg(tree)}`;
  const edit = useEdit(tree);
  // Stays open until the save succeeds, so a failure keeps the edits.
  const saveState = useSaveState(() => onOpenChange(false));
  const toast = useToast();
  const navigate = useNavigate();
  const onRestored = useOpenRestored();
  const queryClient = useQueryClient();
  const [names, setNames] = useState<NameDraft[]>(() => detail.names.map(toDraft));
  const [sex, setSex] = useState<Sex>(detail.person.sex);
  const [living, setLiving] = useState<LivingChoice>(livingChoice(detail.person.living));
  const [links, setLinks] = useState<ParentLink[]>(() => parentLinks(detail));
  const [confirmDelete, setConfirmDelete] = useState(false);
  useDirtyForm({ names, sex, living, links });
  // Given names is what people edit most, so focus starts there.
  const firstGiven = useRef<HTMLInputElement>(null);
  const name = fullName(detail.summary);

  const setName = (index: number, patch: Partial<NameDraft>) =>
    setNames((list) =>
      list.map((n, i) =>
        i === index ? { ...n, ...patch } : patch.isPrimary ? { ...n, isPrimary: false } : n,
      ),
    );

  function save() {
    // First: while a save is in flight the optimistic update makes the page match the
    // draft, so the "nothing changed" check below would close the dialog and lose the
    // edits if that save then fails.
    if (edit.isPending) return;
    const removed = detail.names.filter((row) => !names.some((n) => n.id === row.id));
    const operations: Record<string, unknown>[] = names.flatMap((draft) => {
      const row = detail.names.find((n) => n.id === draft.id);
      const body = nameChanges(draft, row);
      if (row && Object.keys(body).length === 0) return [];
      return [
        row
          ? { op: 'name.update', id: row.id, name: body }
          : { op: 'name.add', personId: id, name: body },
      ];
    });
    // Removed after the adds, so a person never has no name mid-batch.
    for (const row of removed) operations.push({ op: 'name.delete', id: row.id });
    const personPatch: { sex?: Sex; living?: LivingStatus } = {};
    if (sex !== detail.person.sex) personPatch.sex = sex;
    // `unknown` asks the server to infer the status from dates again.
    if (living !== livingChoice(detail.person.living)) {
      personPatch.living = living === 'infer' ? 'unknown' : living;
    }
    if (Object.keys(personPatch).length > 0) {
      operations.push({ op: 'person.update', id, patch: personPatch });
    }
    const before = parentLinks(detail);
    for (const link of links.filter((l, i) => l.rel !== before[i]?.rel)) {
      operations.push({
        op: 'familyChild.update',
        id: link.linkId,
        patch: { [link.slot]: link.rel },
      });
    }

    if (operations.length === 0) return onOpenChange(false);
    const label = `Edit person: ${name}`;
    edit.mutate({
      label,
      optimistic: {
        personId: id,
        update: (current) => applyPerson(applyNames(current, names), personPatch),
      },
      // One request, one change batch: the whole save is a single undo step.
      send: () => apiSend('POST', `${base}/batch`, { label, operations }),
      ...saveState.handlers(),
    });
  }

  function deletePerson() {
    onOpenChange(false);
    const nearby = nearestRelative(detail);
    edit.mutate({
      label: 'Delete person',
      send: () => apiSend<{ batchId: string }>('DELETE', `${base}/people/${id}`),
      onDone: ({ batchId }) => {
        rememberDeletedPerson(batchId, id);
        // Leave first, so the page does not refetch a person who is gone. Stay
        // near where the user was working: a relative, else the people list.
        void (nearby
          ? navigate({ to: '/person/$personId', params: { personId: nearby } })
          : navigate({ to: '/people' }));
        queryClient.removeQueries({ queryKey: personQuery(tree, id).queryKey });
        toast({
          title: `Deleted ${name}`,
          description: 'Press Ctrl+Z (⌘Z on a Mac) to undo.',
          duration: 8000,
          action: {
            label: 'Undo',
            // This delete only: refused if anything was changed after it.
            onClick: () =>
              void undoRedo(queryClient, 'undo', { expect: batchId, onRestored }).then(
                ({ batch }) => batch && toast({ title: `Undid ${batch.label}`, duration: 3000 }),
                (error: unknown) =>
                  toast(
                    error instanceof ApiError && error.code === 'not_newest'
                      ? {
                          title: "Can't undo the delete",
                          description:
                            'Newer changes were made since. Undo them first from History.',
                          variant: 'error',
                        }
                      : {
                          title: 'Could not undo',
                          description: error instanceof Error ? error.message : String(error),
                          variant: 'error',
                        },
                  ),
              ),
          },
        });
      },
    });
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Edit person"
        size="lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          firstGiven.current?.focus();
        }}
        footer={
          <div className={styles.footer}>
            <Button
              variant="danger"
              iconStart={<Trash2 size={16} aria-hidden />}
              onClick={() => setConfirmDelete(true)}
            >
              Delete person
            </Button>
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
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {names.map((draft, index) => (
            <fieldset key={draft.id ?? `new-${index}`} className={styles.fieldset}>
              <legend className={styles.legend}>
                Name {index + 1}
                {draft.isPrimary ? ' (primary)' : ''}
              </legend>
              <div className={styles.grid}>
                <Select
                  label="Name type"
                  value={draft.type}
                  onValueChange={(value) => setName(index, { type: value as NameType })}
                  options={NAME_TYPES}
                />
                <Input
                  label="Given names"
                  ref={index === 0 ? firstGiven : undefined}
                  value={draft.given}
                  onChange={(e) => setName(index, { given: e.currentTarget.value })}
                />
                <Input
                  label="Surname"
                  value={draft.surname}
                  onChange={(e) => setName(index, { surname: e.currentTarget.value })}
                />
                <Input
                  label="Prefix"
                  value={draft.prefix}
                  onChange={(e) => setName(index, { prefix: e.currentTarget.value })}
                />
                <Input
                  label="Suffix"
                  value={draft.suffix}
                  onChange={(e) => setName(index, { suffix: e.currentTarget.value })}
                />
                <Input
                  label="Nickname"
                  value={draft.nickname}
                  onChange={(e) => setName(index, { nickname: e.currentTarget.value })}
                />
              </div>
              <div className={styles.nameActions}>
                {!draft.isPrimary && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setName(index, { isPrimary: true })}
                  >
                    Make primary
                  </Button>
                )}
                {names.length > 1 && !draft.isPrimary && (
                  <IconButton
                    label={`Remove name ${index + 1}`}
                    size="sm"
                    icon={<Trash2 size={14} aria-hidden />}
                    onClick={() => setNames((list) => list.filter((_, i) => i !== index))}
                  />
                )}
              </div>
            </fieldset>
          ))}
          <Button
            size="sm"
            iconStart={<Plus size={14} aria-hidden />}
            onClick={() => setNames((list) => [...list, blankName()])}
          >
            Add name
          </Button>

          <div className={styles.grid}>
            <Select
              label="Sex"
              value={sex}
              onValueChange={(value) => setSex(value as Sex)}
              options={SEX_OPTIONS}
            />
            <Select
              label="Living status"
              value={living}
              onValueChange={(value) => setLiving(value as LivingChoice)}
              hint="Worked out from dates unless you choose. Living people stay private in exports."
              options={[
                {
                  value: 'infer',
                  label: `Work out from dates (now ${isLivingStatus(detail.person.living) ? 'living' : 'deceased'})`,
                },
                { value: 'living', label: 'Living' },
                { value: 'dead', label: 'Deceased' },
              ]}
            />
          </div>

          {links.length > 0 && (
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>Parents</legend>
              <div className={styles.grid}>
                {links.map((link, index) => (
                  <Select
                    key={`${link.linkId}:${link.slot}`}
                    label={`Relationship to ${link.parentName}`}
                    value={link.rel}
                    onValueChange={(value) =>
                      setLinks((list) =>
                        list.map((l, i) =>
                          i === index ? { ...l, rel: value as ChildRelationship } : l,
                        ),
                      )
                    }
                    options={CHILD_RELATIONSHIPS}
                  />
                ))}
              </div>
            </fieldset>
          )}
          {/* Lets Enter in a field submit the form. */}
          <SaveError error={saveState.error} />
          <button type="submit" hidden />
        </form>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${name}?`}
        description="Their names, events and links to family are removed. You can undo this."
        confirmLabel="Delete person"
        onConfirm={deletePerson}
      />
    </>
  );
}
