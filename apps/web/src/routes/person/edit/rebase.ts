import type { PersonNameRow } from '@open-ancestry/db';
import { toDraft, type NameDraft } from './optimistic';

/*
 * "Reload form" after a save was refused as stale: the form moves onto the
 * latest data, keeping only what the user changed since it opened, so the
 * next save neither undoes the other change nor loses the typed one.
 */

/** The user's value if they changed it from `opened`, else the latest one. */
export function rebaseValue<T>(mine: T, opened: T, latest: T): T {
  return mine === opened ? latest : mine;
}

const FIELDS = ['type', 'prefix', 'given', 'surname', 'suffix', 'nickname', 'isPrimary'] as const;

/**
 * Name drafts moved from the rows the form opened on to the latest rows.
 * Names added elsewhere are appended; a name the user removed stays removed;
 * a name deleted elsewhere is dropped unless the user edited it, which keeps
 * it as a new name. One name ends up primary: the user's pick, else the latest.
 */
export function rebaseNames(
  drafts: NameDraft[],
  opened: PersonNameRow[],
  latest: PersonNameRow[],
): NameDraft[] {
  const before = new Map(opened.map((row) => [row.id, toDraft(row)]));
  const now = new Map(latest.map((row) => [row.id, toDraft(row)]));
  let picked: NameDraft | undefined;
  const out = drafts.flatMap((draft): NameDraft[] => {
    const was = draft.id ? before.get(draft.id) : undefined;
    if (!draft.id || !was) {
      if (draft.isPrimary) picked = draft;
      return [draft];
    }
    const changed = FIELDS.filter((field) => draft[field] !== was[field]);
    const base = now.get(draft.id);
    if (!base) return changed.length > 0 ? [{ ...draft, id: undefined }] : [];
    const next = { ...base };
    for (const field of changed) (next as Record<string, unknown>)[field] = draft[field];
    if (changed.includes('isPrimary') && next.isPrimary) picked = next;
    return [next];
  });
  for (const [id, draft] of now) if (!before.has(id)) out.push(draft);
  const primary = picked ?? out.find((n) => n.id && now.get(n.id)?.isPrimary) ?? out[0];
  return out.map((n) => (n.isPrimary === (n === primary) ? n : { ...n, isPrimary: n === primary }));
}
