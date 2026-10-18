import { formatDate, isolate } from '@open-ancestry/core';
import { eventLabel } from '../../lib/timeline';
import type { ImportProgress } from '../../library/api';
import type { FactView, ExportPlaceRename, ReviewChange } from './api';

const SEX: Record<string, string> = { M: 'male', F: 'female', X: 'other', U: 'unknown' };
const NAME_TYPES: Record<string, string> = {
  birth: 'birth name',
  married: 'married name',
  maiden: 'maiden name',
  aka: 'also known as',
  immigrant: 'immigrant name',
  professional: 'professional name',
  religious: 'religious name',
  other: 'other name',
};

/** A fact's date as the app shows dates ("12 Mar 1842", "abt. 1842"), not raw GEDCOM. */
const shownDate = (date: string | null) => (date ? formatDate(date) : null);

// Places and values come from the file: isolated, so none can reorder the label (#264).
const parts = (f: FactView) =>
  [shownDate(f.date), f.place && isolate(f.place), f.value && isolate(f.value)].filter(
    Boolean,
  ) as string[];

/** "Residence, 1900, Millbrook" */
export function factText(f: FactView): string {
  return [eventLabel(f.type, f.customType), ...parts(f)].join(', ');
}

/** "Birth: Abt. 1842 → 12 MAR 1842", naming only the parts that changed. */
export function changeText(before: FactView, after: FactView): string {
  const fields = (['date', 'place', 'value'] as const).filter(
    (k) => (before[k] ?? '') !== (after[k] ?? ''),
  );
  // Dates are shown as the app formats them, unless that hides the difference.
  const raw = shownDate(before.date) === shownDate(after.date);
  const side = (f: FactView) =>
    fields
      .map((k) => (k === 'date' && !raw ? shownDate(f.date) : f[k] && isolate(f[k])) || '(none)')
      .join(', ');
  return `${eventLabel(after.type, after.customType)}: ${side(before)} → ${side(after)}`;
}

const list = (raw: string[]) => {
  const names = raw.map(isolate);
  return names.length <= 1
    ? (names[0] ?? 'unknown')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

/** What ticking a conflicting change does, under its checkbox; undefined for other changes. */
export function conflictText(change: ReviewChange, rawName: string): string | undefined {
  if (change.kind === 'name.add' && change.conflict === 'local-edit') {
    const [name, personName] = [isolate(change.name), isolate(rawName)];
    const was = change.was ? ` (it was ${isolate(change.was)})` : '';
    return `The export now calls this person ${name}${was}; you renamed them ${personName} here. Tick to also keep ${name} as an alternate name; ${personName} stays the primary name.`;
  }
  if (change.conflict === 'local-edit') {
    return 'Edited in this tree since the last import; your edit is kept unless you tick this.';
  }
  if (change.conflict === 'local-delete') {
    return 'You deleted this in this tree; it stays deleted unless you tick this.';
  }
  if (change.conflict === 'renamed-place') {
    return 'You renamed this place in this tree, and the export moves this fact to another place. It stays at your place unless you tick this.';
  }
  return undefined;
}

/** One line describing a change, used as its checkbox label. */
export function describeChange(change: ReviewChange, rawName: string): string {
  // Every name, title and tag here may come from the file: isolated (#264).
  const personName = isolate(rawName);
  const others = (names: string[]) => list(names.filter((n) => n !== rawName));
  switch (change.kind) {
    case 'person.new':
      return `Add ${personName}`;
    case 'sex':
      return `Sex: ${SEX[change.before] ?? change.before} → ${SEX[change.after] ?? change.after}`;
    case 'name.add': {
      // Ticking adds an alternate name: say so when it competes with the user's own.
      const type = change.nameType ? ` (${NAME_TYPES[change.nameType] ?? change.nameType})` : '';
      return change.conflict === 'local-edit'
        ? `Also keep ${isolate(change.name)}${type} as an alternate name`
        : `Add name: ${isolate(change.name)}${type}`;
    }
    case 'fact.add':
      return `Add ${change.owner === 'family' ? 'family fact' : 'fact'}: ${factText(change.fact)}`;
    case 'fact.change':
      // A kept place (the user renamed it) isn't part of the change.
      return changeText(
        change.before,
        change.keepPlace ? { ...change.after, place: change.before.place } : change.after,
      );
    case 'fact.missing':
      return `Not in the new export: ${factText(change.fact)}`;
    case 'citation.add':
      return `Add source: ${[change.source, change.page]
        .filter((part): part is string => !!part)
        .map(isolate)
        .join(', ')}`;
    case 'tag.add':
      return `Add tag: ${isolate(change.tag)}`;
    case 'media.add':
      return `Add media: ${change.title ? isolate(change.title) : 'untitled'}`;
    case 'media.file':
      return `Add the file for ${change.title ? isolate(change.title) : 'untitled media'}`;
    case 'media.replace':
      return `Use the new export's file for ${change.title ? isolate(change.title) : 'untitled media'}`;
    case 'family.add':
      return `Partner: ${others(change.partnerNames)}`;
    case 'child.add':
      return `Child of ${list(change.parentNames)}`;
    case 'person.missing':
      return 'Not in the new export';
    case 'family.missing':
      return `Not in the new export: partner ${others(change.partnerNames)}. Kept in your tree.`;
    case 'child.missing':
      return `Not in the new export: child of ${list(change.parentNames)}. Kept in your tree.`;
    case 'deleted-here':
      return `You deleted ${personName} from this tree; not added back unless you tick it`;
    case 'unlinked-new':
      return 'New child of a partnership not in this tree; tick to add';
    case 'possible-match':
      return change.taken
        ? `Looks like ${isolate(change.existingName)} (${Math.round(change.confidence * 100)}%), who is already matched; not added unless you tick it`
        : `Possibly ${isolate(change.existingName)} (${Math.round(change.confidence * 100)}% match); not added unless you tick it`;
    case 'possibly-merged':
      return `Possibly merged into ${isolate(change.existingName)} earlier (shares a relative); not added unless you tick it`;
    case 'merged':
      return `Exported separately as ${isolate(change.incomingName)}; previously merged into ${personName}, so not added again`;
  }
}

const COMPARE_PHASES: Record<ImportProgress['phase'], string> = {
  read: 'Reading the file',
  parse: 'Reading the file',
  map: 'Reading people and families',
  finalize: 'Reading people and families',
  commit: 'Reading people and families',
  done: 'Comparing with your tree',
  compare: 'Comparing with your tree',
};

/** What a re-import's comparison is doing, for its progress page (#161). */
export function compareProgress(progress: ImportProgress | null | undefined): string {
  if (!progress) return 'Uploading';
  const counts =
    progress.phase === 'map' && progress.total > 0
      ? ` (${progress.done.toLocaleString('en-US')} of ${progress.total.toLocaleString('en-US')} records)`
      : '';
  return `${COMPARE_PHASES[progress.phase]}${counts}`;
}

/** "Place renamed: Millbrook → Millbrook Falls (6 facts)" */
export function placeRenameText(rename: ExportPlaceRename): string {
  const n = rename.changeIds.length;
  return `Place renamed: ${isolate(rename.from)} → ${isolate(rename.to)} (${n} fact${n === 1 ? '' : 's'})`;
}
