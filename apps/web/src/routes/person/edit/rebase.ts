import type { PersonNameRow } from '@open-ancestry/db';
import { toDraft, type NameDraft } from './optimistic';

/*
 * "Reload form" after a save was refused as stale: the form moves onto the
 * latest data, keeping only what the user changed since it opened, so the
 * next save neither undoes the other change nor loses the typed one. Where
 * both changed the same field the user's value is kept but reported as a
 * conflict, so the form can point it out instead of overwriting silently.
 */

/** Text as stored: trimmed and NFC, so a whitespace-only or NFD "edit" is no edit. */
const norm = (value: unknown) =>
  typeof value === 'string' ? value.trim().normalize('NFC') : value;

export interface Rebased<T> {
  value: T;
  /** Both the user and someone else changed it, to different values. */
  conflict: boolean;
}

/** The user's value if they changed it from `opened`, else the latest one. */
export function rebaseValue<T>(mine: T, opened: T, latest: T): Rebased<T> {
  if (norm(mine) === norm(opened)) return { value: latest, conflict: false };
  const conflict = norm(latest) !== norm(opened) && norm(latest) !== norm(mine);
  return { value: mine, conflict };
}

const TEXT = ['type', 'prefix', 'given', 'surname', 'suffix', 'nickname'] as const;
export type NameField = (typeof TEXT)[number];

export interface RebasedNames {
  names: NameDraft[];
  /** `${nameId}:${field}` to the value saved elsewhere, where both changed it. */
  conflicts: Map<string, string>;
  /** The name the user made primary was deleted elsewhere, so it is not primary now. */
  primaryDropped: boolean;
}

/**
 * Name drafts moved from the rows the form opened on to the latest rows.
 * Names added elsewhere are appended; a name the user removed stays removed;
 * a name deleted elsewhere is dropped unless the user edited its text, which
 * keeps it as a new name. One name ends up primary: the user's pick, else the latest.
 */
export function rebaseNames(
  drafts: NameDraft[],
  opened: PersonNameRow[],
  latest: PersonNameRow[],
): RebasedNames {
  const before = new Map(opened.map((row) => [row.id, toDraft(row)]));
  const now = new Map(latest.map((row) => [row.id, toDraft(row)]));
  const conflicts = new Map<string, string>();
  let picked: NameDraft | undefined;
  let primaryDropped = false;
  const names = drafts.flatMap((draft): NameDraft[] => {
    const was = draft.id ? before.get(draft.id) : undefined;
    if (!draft.id || !was) {
      if (draft.isPrimary) picked = draft;
      return [draft];
    }
    const pickedHere = draft.isPrimary && !was.isPrimary;
    const base = now.get(draft.id);
    if (!base) {
      if (pickedHere) primaryDropped = true;
      const edited = TEXT.some((field) => norm(draft[field]) !== norm(was[field]));
      return edited ? [{ ...draft, id: undefined, isPrimary: false }] : [];
    }
    const next = { ...base };
    for (const field of TEXT) {
      const { value, conflict } = rebaseValue(draft[field], was[field], base[field]);
      (next as Record<NameField, string>)[field] = value as string;
      if (conflict) conflicts.set(`${draft.id}:${field}`, base[field]);
    }
    if (draft.isPrimary !== was.isPrimary) next.isPrimary = draft.isPrimary;
    if (pickedHere) picked = next;
    return [next];
  });
  for (const [id, draft] of now) if (!before.has(id)) names.push(draft);
  const primary = picked ?? names.find((n) => n.id && now.get(n.id)?.isPrimary) ?? names[0];
  return {
    names: names.map((n) =>
      n.isPrimary === (n === primary) ? n : { ...n, isPrimary: n === primary },
    ),
    conflicts,
    primaryDropped,
  };
}
