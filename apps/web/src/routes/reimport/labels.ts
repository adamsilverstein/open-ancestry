import { eventLabel } from '../../lib/timeline';
import type { ImportProgress } from '../../library/api';
import type { FactView, ReviewChange } from './api';

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

const parts = (f: FactView) => [f.date, f.place, f.value].filter(Boolean) as string[];

/** "Residence, 1900, Millbrook" */
export function factText(f: FactView): string {
  return [eventLabel(f.type, f.customType), ...parts(f)].join(', ');
}

/** "Birth: Abt. 1842 → 12 MAR 1842", naming only the parts that changed. */
export function changeText(before: FactView, after: FactView): string {
  const fields = (['date', 'place', 'value'] as const).filter(
    (k) => (before[k] ?? '') !== (after[k] ?? ''),
  );
  const side = (f: FactView) => fields.map((k) => f[k] || '(none)').join(', ');
  return `${eventLabel(after.type, after.customType)}: ${side(before)} → ${side(after)}`;
}

const list = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? 'unknown')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** One line describing a change, used as its checkbox label. */
export function describeChange(change: ReviewChange, personName: string): string {
  switch (change.kind) {
    case 'person.new':
      return `Add ${personName}`;
    case 'sex':
      return `Sex: ${SEX[change.before] ?? change.before} → ${SEX[change.after] ?? change.after}`;
    case 'name.add':
      return `Add name: ${change.name} (${NAME_TYPES[change.nameType] ?? change.nameType})`;
    case 'fact.add':
      return `Add ${change.owner === 'family' ? 'family fact' : 'fact'}: ${factText(change.fact)}`;
    case 'fact.change':
      return changeText(change.before, change.after);
    case 'fact.missing':
      return `Not in the new export: ${factText(change.fact)}`;
    case 'citation.add':
      return `Add source: ${[change.source, change.page].filter(Boolean).join(', ')}`;
    case 'tag.add':
      return `Add tag: ${change.tag}`;
    case 'media.add':
      return `Add media: ${change.title ?? 'untitled'}`;
    case 'media.file':
      return `Add the file for ${change.title ?? 'untitled media'}`;
    case 'family.add':
      return `Partner: ${list(change.partnerNames.filter((n) => n !== personName))}`;
    case 'child.add':
      return `Child of ${list(change.parentNames)}`;
    case 'person.missing':
      return 'Not in the new export';
    case 'family.missing':
      return `Not in the new export: partner ${list(change.partnerNames.filter((n) => n !== personName))}. Kept in your tree.`;
    case 'child.missing':
      return `Not in the new export: child of ${list(change.parentNames)}. Kept in your tree.`;
    case 'deleted-here':
      return `You deleted ${personName} from this tree; not added back unless you tick it`;
    case 'unlinked-new':
      return 'New child of a partnership not in this tree; tick to add';
    case 'possible-match':
      return change.taken
        ? `Looks like ${change.existingName} (${Math.round(change.confidence * 100)}%), who is already matched; not added unless you tick it`
        : `Possibly ${change.existingName} (${Math.round(change.confidence * 100)}% match); not added unless you tick it`;
    case 'possibly-merged':
      return `Possibly merged into ${change.existingName} earlier (shares a relative); not added unless you tick it`;
    case 'merged':
      return `Exported separately as ${change.incomingName}; previously merged into ${personName}, so not added again`;
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
