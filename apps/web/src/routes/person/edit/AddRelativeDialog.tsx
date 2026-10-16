import { isolate } from '@open-ancestry/core';
import { useDeferredValue, useId, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ChildRelationship, RelationshipType } from '@open-ancestry/db';
import { seg } from '../../../api/client';
import { useEdit } from '../../../api/edits';
import { apiSend } from '../../../api/client';
import { searchQuery } from '../../../api/search';
import type { ApiPersonSummary, PersonDetail } from '../../../api/types';
import { Button } from '../../../components/Button/Button';
import { Combobox } from '../../../components/Combobox/Combobox';
import { Dialog, DialogClose } from '../../../components/Dialog/Dialog';
import { Select } from '../../../components/Select/Select';
import { formatLifespan } from '../../../lib/lifespan';
import { fullName, lifeDate } from '../../../lib/person';
import { CHILD_RELATIONSHIPS, RELATIONSHIP_TYPES } from './EditPersonDialog';
import { NewPersonFields, useNewPerson } from './NewPersonFields';
import { SaveError, useSaveState } from './SaveError';
import { useDirtyForm } from './dirty';
import styles from './Edit.module.css';

export type RelativeKind = 'parent' | 'spouse' | 'child' | 'sibling';

export const RELATIVE_TITLES: Record<RelativeKind, string> = {
  parent: 'Add parent',
  spouse: 'Add spouse',
  child: 'Add child',
  sibling: 'Add sibling',
};

function describe(person: ApiPersonSummary): string {
  const lifespan = formatLifespan({
    birth: lifeDate(person.birth),
    death: lifeDate(person.death),
  });
  return lifespan ? `${fullName(person)} (${lifespan})` : fullName(person);
}

interface AddRelativeDialogProps {
  tree: string;
  detail: PersonDetail;
  kind: RelativeKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Adds a parent, spouse, child or sibling: a new person, or one already in the tree. */
export function AddRelativeDialog({
  tree,
  detail,
  kind,
  open,
  onOpenChange,
}: AddRelativeDialogProps) {
  const id = detail.person.id;
  const edit = useEdit(tree);
  // Stays open until the save succeeds, so a failure keeps what was typed.
  const saveState = useSaveState(() => onOpenChange(false));
  const radioName = useId();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const draft = useNewPerson();
  const [query, setQuery] = useState('');
  const [existing, setExisting] = useState<ApiPersonSummary | null>(null);
  const [rel, setRel] = useState<ChildRelationship>('biological');
  const [relationshipType, setRelationshipType] = useState<RelationshipType>('married');
  const families = detail.partnerFamilies;
  useDirtyForm({
    given: draft.given,
    surname: draft.surname,
    birth: draft.birth,
    existing: existing?.id ?? null,
  });
  const [familyId, setFamilyId] = useState<string>(families[0]?.family.id ?? 'none');

  const q = useDeferredValue(query.trim());
  const searching = mode === 'existing' && /[\p{L}\p{N}]/u.test(q);
  const { data } = useQuery({
    ...searchQuery(tree, q, 10),
    enabled: searching,
    placeholderData: keepPreviousData,
  });
  const results = (data?.items ?? []).map((hit) => hit.person);
  const options = (searching ? results : [])
    .filter((p) => p.id !== id)
    .map((p) => ({ value: p.id, label: describe(p) }));

  const ready = mode === 'existing' ? existing !== null : draft.ready;

  function save() {
    if (!ready || edit.isPending) return;
    const relative = mode === 'existing' ? { personId: existing!.id } : { person: draft.body() };
    const base = `/trees/${seg(tree)}/people/${id}`;
    const body =
      kind === 'parent'
        ? { ...relative, rel }
        : kind === 'spouse'
          ? { ...relative, relationship_type: relationshipType }
          : kind === 'child' && familyId !== 'none'
            ? { ...relative, familyId }
            : relative;
    edit.mutate({
      label: RELATIVE_TITLES[kind],
      send: () => apiSend('POST', `${base}/${kind === 'child' ? 'children' : `${kind}s`}`, body),
      ...saveState.handlers(),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={RELATIVE_TITLES[kind]}
      // Start in Given names, so typing a name works right away.
      onOpenAutoFocus={(event) => {
        const first = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
          'input:not([type="radio"])',
        );
        if (!first) return;
        event.preventDefault();
        first.focus();
      }}
      description={`Of ${isolate(fullName(detail.summary))}`}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" onClick={save} disabled={!ready} loading={edit.isPending}>
            {saveState.submitLabel('Add')}
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <fieldset className={styles.choice}>
          <legend className="oa-visually-hidden">Who to add</legend>
          <label>
            <input
              type="radio"
              name={radioName}
              checked={mode === 'new'}
              onChange={() => setMode('new')}
            />
            New person
          </label>
          <label>
            <input
              type="radio"
              name={radioName}
              checked={mode === 'existing'}
              onChange={() => setMode('existing')}
            />
            Existing person
          </label>
        </fieldset>

        {mode === 'new' ? (
          <NewPersonFields
            draft={draft}
            errors={saveState.field ? { [saveState.field.field]: saveState.field.message } : {}}
          />
        ) : (
          <Combobox
            label="Person"
            placeholder="Search by name, place or year"
            searchLabel="Search people"
            emptyText={searching ? 'No matching people' : 'Type a name to search'}
            options={options}
            value={existing?.id}
            selectedLabel={existing ? describe(existing) : undefined}
            onSearchChange={setQuery}
            onValueChange={(value) => setExisting(results.find((p) => p.id === value) ?? null)}
          />
        )}

        {kind === 'parent' && (
          <Select
            label="Relationship"
            value={rel}
            onValueChange={(value) => setRel(value as ChildRelationship)}
            options={CHILD_RELATIONSHIPS}
          />
        )}
        {kind === 'spouse' && (
          <Select
            label="Relationship type"
            value={relationshipType}
            onValueChange={(value) => setRelationshipType(value as RelationshipType)}
            options={RELATIONSHIP_TYPES}
          />
        )}
        {kind === 'child' && (
          <Select
            label="Other parent"
            value={familyId}
            onValueChange={setFamilyId}
            options={[
              ...families.map((f) => ({
                value: f.family.id,
                label: f.partner ? fullName(f.partner) : 'Unknown partner',
              })),
              { value: 'none', label: 'No other parent' },
            ]}
          />
        )}
        <SaveError error={saveState.error} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
