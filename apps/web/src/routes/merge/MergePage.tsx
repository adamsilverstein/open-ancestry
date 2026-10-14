import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { ArrowLeftRight, Merge } from 'lucide-react';
import { formatDate } from '@open-ancestry/core';
import { apiSend, seg } from '../../api/client';
import { useEdit } from '../../api/edits';
import { currentTreeQuery, personQuery } from '../../api/queries';
import type { EventDetail, PersonDetail } from '../../api/types';
import { Button } from '../../components/Button/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState/EmptyState';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { useToast } from '../../components/Toast/Toast';
import { fullName, isLivingStatus } from '../../lib/person';
import { eventLabel } from '../../lib/timeline';
import styles from './MergePage.module.css';

const route = getRouteApi('/merge');

type Side = 'keep' | 'other';

/** Facts a person has once; when both records have one, the user picks. */
const SINGULAR = ['BIRT', 'CHR', 'BAPM', 'DEAT', 'BURI', 'CREM'];
const SEX = { M: 'Male', F: 'Female', X: 'Other', U: 'Unknown' } as Record<string, string>;

function factText(item: EventDetail | undefined): string {
  if (!item) return '';
  const date = item.event.date_text ? formatDate(item.event.date_text) : '';
  return [date, item.place?.full_name].filter(Boolean).join(', ') || 'No date or place';
}

const preferredFact = (detail: PersonDetail, type: string) =>
  detail.events.find(
    (e) => e.event.type === type && e.role.role === 'principal' && e.role.is_preferred === 1,
  );

interface Row {
  key: string;
  label: string;
  values: [string, string];
  /** Choosable when both sides have different values. */
  choice?: 'name' | 'sex' | 'living' | `fact:${string}`;
}

function rows(keep: PersonDetail, other: PersonDetail): Row[] {
  const list: Row[] = [];
  const add = (row: Row) => {
    const [a, b] = row.values;
    list.push(a && b && a !== b ? row : { ...row, choice: undefined });
  };
  add({
    key: 'name',
    label: 'Name',
    values: [fullName(keep.summary), fullName(other.summary)],
    choice: 'name',
  });
  add({
    key: 'sex',
    label: 'Sex',
    values: [SEX[keep.person.sex] ?? '', SEX[other.person.sex] ?? ''],
    choice: 'sex',
  });
  const living = (d: PersonDetail) =>
    d.person.living === 'living' || d.person.living === 'dead'
      ? d.person.living === 'living'
        ? 'Living (set)'
        : 'Deceased (set)'
      : isLivingStatus(d.person.living)
        ? 'Living (worked out)'
        : 'Deceased (worked out)';
  add({
    key: 'living',
    label: 'Living status',
    values: [living(keep), living(other)],
    choice: 'living',
  });
  for (const type of SINGULAR) {
    const a = preferredFact(keep, type);
    const b = preferredFact(other, type);
    if (!a && !b) continue;
    add({
      key: type,
      label: eventLabel(type),
      values: [factText(a), factText(b)],
      choice: `fact:${type}`,
    });
  }
  const others = (d: PersonDetail) =>
    d.events
      .filter((e) => !SINGULAR.includes(e.event.type) || e.role.is_preferred === 0)
      .map((e) => `${eventLabel(e.event.type, e.event.custom_type)} ${factText(e)}`)
      .join('; ');
  const names = (people: (PersonDetail['summary'] | null)[]) =>
    people
      .filter((p) => p !== null)
      .map((p) => fullName(p!))
      .join(', ');
  const combined: [string, (d: PersonDetail) => string][] = [
    ['Other facts', others],
    ['Parents', (d) => names(d.parentFamilies.flatMap((f) => [f.partner1, f.partner2]))],
    ['Spouses', (d) => names(d.partnerFamilies.map((f) => f.partner))],
    ['Children', (d) => names(d.partnerFamilies.flatMap((f) => f.children.map((c) => c.person)))],
    ['Sources', (d) => (d.citations.length ? `${d.citations.length} on the person` : '')],
    ['Media', (d) => (d.media.length ? `${d.media.length}` : '')],
    ['Tags', (d) => d.tags.map((t) => t.name).join(', ')],
    ['Notes', (d) => (d.notes.length ? `${d.notes.length}` : '')],
  ];
  for (const [label, read] of combined) {
    const values: [string, string] = [read(keep), read(other)];
    if (values[0] || values[1]) list.push({ key: label, label, values });
  }
  return list;
}

/** Side-by-side compare of two records, then one undoable merge. */
export function MergePage() {
  const { keep, other } = route.useSearch();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: tree } = useQuery(currentTreeQuery);
  const left = useQuery({ ...personQuery(tree ?? '', keep ?? ''), enabled: !!tree && !!keep });
  const right = useQuery({ ...personQuery(tree ?? '', other ?? ''), enabled: !!tree && !!other });
  const edit = useEdit(tree ?? '');
  const [picks, setPicks] = useState<Record<string, Side>>({});
  const [confirm, setConfirm] = useState(false);

  if (!keep || !other || keep === other || left.isError || right.isError) {
    return (
      <div className={styles.page}>
        <EmptyState
          level={1}
          title="Choose two people to merge"
          description="Open a possible duplicate in the tree checker and choose Compare and merge."
        />
      </div>
    );
  }
  const a = left.data;
  const b = right.data;
  const table = a && b ? rows(a, b) : [];
  const nameA = a ? fullName(a.summary) : '';
  const nameB = b ? fullName(b.summary) : '';

  const merge = () => {
    const choices: Record<string, unknown> = {};
    const preferred: Record<string, Side> = {};
    for (const [choice, side] of Object.entries(picks)) {
      if (choice.startsWith('fact:')) preferred[choice.slice(5)] = side;
      else choices[choice] = side;
    }
    if (Object.keys(preferred).length) choices.preferred = preferred;
    edit.mutate({
      label: `Merge ${nameB} into ${nameA}`,
      send: () =>
        apiSend('POST', `/trees/${seg(tree!)}/people/${seg(keep)}/merge`, {
          otherId: other,
          choices,
        }),
      onDone: () => {
        toast({
          title: `Merged ${nameB} into ${nameA}`,
          description: 'Press Ctrl+Z (⌘Z on a Mac) to undo.',
        });
        void navigate({ to: '/person/$personId', params: { personId: keep } });
      },
    });
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Merge duplicates</h1>
        <p className={styles.intro}>
          Compare the two records. Where they differ, choose which to keep; the other becomes an
          alternate fact. Relationships, sources, media, notes and tags from both are combined.
        </p>
      </header>
      {!a || !b ? (
        <div aria-busy="true" className={styles.loading}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={40} />
          ))}
        </div>
      ) : (
        <>
          <div className={styles.scroller}>
            <table className={styles.table} aria-label="Compare records">
              <thead>
                <tr>
                  <th scope="col">Detail</th>
                  <th scope="col">Keep: {nameA}</th>
                  <th scope="col">Merge in: {nameB}</th>
                </tr>
              </thead>
              <tbody>
                {table.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    {([0, 1] as const).map((i) => {
                      const side: Side = i === 0 ? 'keep' : 'other';
                      const value = row.values[i];
                      const owner = i === 0 ? nameA : nameB;
                      return (
                        <td key={side}>
                          {row.choice ? (
                            <label className={styles.choice}>
                              <input
                                type="radio"
                                name={row.key}
                                checked={(picks[row.choice] ?? 'keep') === side}
                                onChange={() => setPicks((p) => ({ ...p, [row.choice!]: side }))}
                                aria-label={`${row.label} from ${owner}: ${value}`}
                              />
                              <span>{value}</span>
                            </label>
                          ) : (
                            <span className={value ? undefined : styles.none}>
                              {value || 'None'}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.actions}>
            <Button
              iconStart={<ArrowLeftRight size={16} aria-hidden />}
              onClick={() => {
                setPicks({});
                void navigate({
                  to: '/merge',
                  search: { keep: other, other: keep },
                  replace: true,
                });
              }}
            >
              Swap sides
            </Button>
            <Button
              variant="primary"
              iconStart={<Merge size={16} aria-hidden />}
              onClick={() => setConfirm(true)}
            >
              Merge
            </Button>
          </div>
          <ConfirmDialog
            open={confirm}
            onOpenChange={setConfirm}
            title={`Merge ${nameB} into ${nameA}?`}
            description={`${nameB} is removed and everything recorded for them moves to ${nameA}. You can undo this.`}
            confirmLabel="Merge"
            danger={false}
            onConfirm={merge}
          />
        </>
      )}
    </div>
  );
}
