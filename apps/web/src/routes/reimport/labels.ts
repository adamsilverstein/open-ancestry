import { eventLabel } from '../../lib/timeline';
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

/** What ticking a conflicting change does, under its checkbox; undefined for other changes. */
export function conflictText(change: ReviewChange, personName: string): string | undefined {
  if (change.kind === 'name.add' && change.conflict === 'local-edit') {
    return `The export still calls this person ${change.name}; you renamed them ${personName} here. Tick to also keep ${change.name} as an alternate name; ${personName} stays the primary name.`;
  }
  if (change.kind === 'name.add' && change.conflict === 'local-delete') {
    return `You deleted the name ${change.name} here. Tick to add it back as an alternate name.`;
  }
  if (change.conflict === 'local-edit') {
    return 'Edited in this tree since the last import; your edit is kept unless you tick this.';
  }
  if (change.conflict === 'local-delete') {
    return 'You deleted this in this tree; it stays deleted unless you tick this.';
  }
  return undefined;
}

/** One line describing a change, used as its checkbox label. */
export function describeChange(change: ReviewChange, personName: string): string {
  switch (change.kind) {
    case 'person.new':
      return `Add ${personName}`;
    case 'sex':
      return `Sex: ${SEX[change.before] ?? change.before} → ${SEX[change.after] ?? change.after}`;
    case 'name.add':
      // Ticking adds an alternate name: say so when it competes with the user's own.
      if (change.conflict === 'local-edit') return `Also keep ${change.name} as an alternate name`;
      return change.nameType
        ? `Add name: ${change.name} (${NAME_TYPES[change.nameType] ?? change.nameType})`
        : `Add name: ${change.name}`;
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
      return `Looks like ${change.existingName}, who is already matched; not added unless you tick it`;
    case 'possibly-merged':
      return `Possibly merged into ${change.existingName} earlier (shares a relative); not added unless you tick it`;
    case 'merged':
      return `Exported separately as ${change.incomingName}; previously merged into ${personName}, so not added again`;
  }
}
