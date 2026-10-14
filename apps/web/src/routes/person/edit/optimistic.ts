import type { NameType, PersonNameRow, Sex, LivingStatus } from '@open-ancestry/db';
import type { PersonDetail } from '../../../api/types';

/*
 * Pure updates of a cached PersonDetail, applied before the server answers
 * so edits show instantly; the edit hook restores the old detail on error.
 */

/** A name as edited in the form; `id` is absent for a new name. */
export interface NameDraft {
  id?: string | undefined;
  type: NameType;
  prefix: string;
  given: string;
  surname: string;
  suffix: string;
  nickname: string;
  isPrimary: boolean;
}

export const NAME_FIELDS = ['prefix', 'given', 'surname', 'suffix', 'nickname'] as const;

const orNull = (value: string) => (value.trim() ? value.trim() : null);

export function toDraft(name: PersonNameRow): NameDraft {
  return {
    id: name.id,
    type: name.type,
    prefix: name.prefix ?? '',
    given: name.given ?? '',
    surname: name.surname ?? '',
    suffix: name.suffix ?? '',
    nickname: name.nickname ?? '',
    isPrimary: name.is_primary === 1,
  };
}

/** Fields of a draft that differ from the stored row, as an API body. */
export function nameChanges(draft: NameDraft, row?: PersonNameRow): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const field of NAME_FIELDS) {
    const next = orNull(draft[field]);
    if (!row || next !== row[field]) changes[field] = next;
  }
  if (!row || draft.type !== row.type) changes.type = draft.type;
  if (draft.isPrimary && (!row || row.is_primary !== 1)) changes.is_primary = true;
  return changes;
}

export function applyNames(detail: PersonDetail, drafts: NameDraft[]): PersonDetail {
  const names = drafts.map((draft, index): PersonNameRow => {
    const existing = detail.names.find((n) => n.id === draft.id);
    return {
      ...(existing ?? {
        id: `pending-${index}`,
        person_id: detail.person.id,
        full_text: null,
        surname_key: null,
        surname_prefix: null,
        sort_order: index,
      }),
      type: draft.type,
      prefix: orNull(draft.prefix),
      given: orNull(draft.given),
      surname: orNull(draft.surname),
      suffix: orNull(draft.suffix),
      nickname: orNull(draft.nickname),
      is_primary: draft.isPrimary ? 1 : 0,
    } as PersonNameRow;
  });
  const primary = names.find((n) => n.is_primary === 1) ?? names[0];
  return {
    ...detail,
    names,
    summary: primary
      ? {
          ...detail.summary,
          given: primary.given,
          surname: primary.surname,
          surnamePrefix: primary.surname_prefix,
          prefix: primary.prefix,
          suffix: primary.suffix,
          nickname: primary.nickname,
        }
      : detail.summary,
  };
}

export function applyPerson(
  detail: PersonDetail,
  patch: { sex?: Sex; living?: LivingStatus },
): PersonDetail {
  return {
    ...detail,
    person: { ...detail.person, ...patch },
    summary: { ...detail.summary, ...patch },
  };
}

export function removeEvent(detail: PersonDetail, eventId: string): PersonDetail {
  const keep = (e: { event: { id: string } }) => e.event.id !== eventId;
  return {
    ...detail,
    events: detail.events.filter(keep),
    partnerFamilies: detail.partnerFamilies.map((f) => ({ ...f, events: f.events.filter(keep) })),
    summary: {
      ...detail.summary,
      birth: detail.summary.birth?.eventId === eventId ? null : detail.summary.birth,
      death: detail.summary.death?.eventId === eventId ? null : detail.summary.death,
    },
  };
}

export function setNoteText(detail: PersonDetail, noteId: string, text: string): PersonDetail {
  const edit = <N extends { id: string; text: string }>(n: N) =>
    n.id === noteId ? { ...n, text } : n;
  return {
    ...detail,
    notes: detail.notes.map(edit),
    events: detail.events.map((e) => ({ ...e, notes: e.notes.map(edit) })),
  };
}

export function removeNote(detail: PersonDetail, noteId: string): PersonDetail {
  const keep = (n: { id: string }) => n.id !== noteId;
  return {
    ...detail,
    notes: detail.notes.filter(keep),
    events: detail.events.map((e) => ({ ...e, notes: e.notes.filter(keep) })),
  };
}

export function removeTag(detail: PersonDetail, tagId: string): PersonDetail {
  return { ...detail, tags: detail.tags.filter((t) => t.id !== tagId) };
}
