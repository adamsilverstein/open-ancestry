import type { ComponentProps } from 'react';
import { BookMarked, CircleCheck, Link2, Lock, Mars, UserRound, Venus } from 'lucide-react';
import { cx } from '../../lib/cx';
import { formatLifespan } from '../../lib/lifespan';
import { sexLabel, type PersonSummary } from '../../lib/person';
import { Avatar } from '../Avatar/Avatar';
import { LifespanText } from '../LifespanText/LifespanText';
import styles from './PersonCard.module.css';

export type PersonCardSize = 'compact' | 'regular';

export interface PersonCardProps extends Omit<ComponentProps<'button'>, 'children'> {
  person: PersonSummary;
  /** `compact` 96x120, `regular` 120x150. */
  size?: PersonCardSize;
  selected?: boolean;
  /** The person the tree is centered on. */
  focusPerson?: boolean;
  /** Pedigree collapse: this person already appears elsewhere in the view. */
  duplicate?: boolean;
  /** Living person hidden for privacy: name and dates are withheld. */
  isPrivate?: boolean;
}

const sexIcon = { M: Mars, F: Venus, U: UserRound } as const;

/** Builds the card's accessible name so every visual state is also announced. */
export function personCardLabel({
  person,
  selected,
  focusPerson,
  duplicate,
  isPrivate,
}: Pick<PersonCardProps, 'person' | 'selected' | 'focusPerson' | 'duplicate' | 'isPrivate'>) {
  const parts = isPrivate
    ? ['Private person', 'private']
    : [person.name, sexLabel[person.sex], formatLifespan(person)];
  if (focusPerson) parts.push('focus person');
  if (selected) parts.push('selected');
  if (duplicate) parts.push('duplicate, also shown elsewhere in the tree');
  if (!isPrivate && person.sourceCount) {
    parts.push(`${person.sourceCount} source${person.sourceCount === 1 ? '' : 's'}`);
  }
  if (!isPrivate && person.tags?.length) {
    parts.push(`tags: ${person.tags.map((t) => t.label).join(', ')}`);
  }
  return parts.filter(Boolean).join(', ');
}

/** Tree card: sex shown by stripe color and icon, states by border style and icons. */
export function PersonCard({
  person,
  size = 'regular',
  selected = false,
  focusPerson = false,
  duplicate = false,
  isPrivate = false,
  className,
  type = 'button',
  ...rest
}: PersonCardProps) {
  const SexIcon = sexIcon[person.sex];
  return (
    <button
      type={type}
      aria-label={personCardLabel({ person, selected, focusPerson, duplicate, isPrivate })}
      className={cx(
        styles.card,
        styles[size],
        styles[`sex${isPrivate ? 'U' : person.sex}`],
        selected && styles.selected,
        focusPerson && styles.focusPerson,
        duplicate && styles.duplicate,
        className,
      )}
      data-selected={selected || undefined}
      {...rest}
    >
      <span className={styles.avatarWrap}>
        {isPrivate ? (
          <span className={styles.privateAvatar}>
            <Lock size={size === 'compact' ? 18 : 22} aria-hidden />
          </span>
        ) : (
          <Avatar
            name={person.name}
            sex={person.sex}
            src={person.photoUrl}
            size={size === 'compact' ? 40 : 64}
            decorative
          />
        )}
        {/* Private cards withhold everything but the fact a person is there. */}
        {!isPrivate && (
          <span className={styles.sexBadge}>
            <SexIcon size={12} strokeWidth={2.5} aria-hidden />
          </span>
        )}
      </span>
      <span className={styles.name}>{isPrivate ? 'Private' : person.name}</span>
      {!isPrivate && <LifespanText className={styles.lifespan} {...person} />}
      <span className={styles.badges} aria-hidden>
        {selected && <CircleCheck size={12} className={styles.selectedBadge} />}
        {duplicate && <Link2 size={12} />}
        {!isPrivate && person.sourceCount ? <BookMarked size={12} /> : null}
        {!isPrivate &&
          person.tags?.map((tag) => (
            <span
              key={tag.label}
              className={styles.tagDot}
              style={{ background: `var(--oa-tag-${tag.color})` }}
            />
          ))}
      </span>
    </button>
  );
}
