import { useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { Crosshair, Pencil, UserRound } from 'lucide-react';
import type { PersonSummary } from '../../lib/person';
import { Avatar } from '../Avatar/Avatar';
import { Button } from '../Button/Button';
import buttonStyles from '../Button/Button.module.css';
import { LifespanText } from '../LifespanText/LifespanText';
import { Popover, PopoverContent, PopoverTrigger } from '../Popover/Popover';
import { cx } from '../../lib/cx';
import styles from './QuickViewPopover.module.css';

export interface LifeEvent {
  /** Display date, e.g. `5 Sep 1911` or `abt. 1890`. */
  date?: string | undefined;
  place?: string | undefined;
}

export interface QuickViewPopoverProps {
  person: PersonSummary;
  birth?: LifeEvent | undefined;
  death?: LifeEvent | undefined;
  onMakeFocus?: (person: PersonSummary) => void;
  onEdit?: (person: PersonSummary) => void;
  /** The card or button that opens the popover. */
  children: ReactElement;
}

function eventLine(label: string, event: LifeEvent | undefined) {
  if (!event?.date && !event?.place) return null;
  return (
    <p className={styles.event}>
      <span className={styles.eventLabel}>{label}</span>{' '}
      {[event.date, event.place].filter(Boolean).join(', ')}
    </p>
  );
}

/** Card click summary: photo, name, birth and death, and the main actions. */
export function QuickViewPopover({
  person,
  birth,
  death,
  onMakeFocus,
  onEdit,
  children,
}: QuickViewPopoverProps) {
  const [open, setOpen] = useState(false);
  const run = (action?: (p: PersonSummary) => void) => () => {
    setOpen(false);
    action?.(person);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent label={person.name} className={styles.content} side="right" align="start">
        <div className={styles.header}>
          <Avatar name={person.name} sex={person.sex} src={person.photoUrl} size={64} decorative />
          <div>
            <p className={styles.name}>{person.name}</p>
            <LifespanText className={styles.lifespan} {...person} />
          </div>
        </div>
        <div className={styles.events}>
          {eventLine('Born', birth)}
          {person.living ? <p className={styles.event}>Living</p> : eventLine('Died', death)}
        </div>
        <div className={styles.actions}>
          <Link
            to="/person/$personId"
            params={{ personId: person.id }}
            className={cx(buttonStyles.button, buttonStyles.primary, buttonStyles.sm)}
          >
            <UserRound size={14} aria-hidden />
            Profile
          </Link>
          <Button
            size="sm"
            iconStart={<Crosshair size={14} aria-hidden />}
            onClick={run(onMakeFocus)}
          >
            Make focus
          </Button>
          <Button
            size="sm"
            variant="ghost"
            iconStart={<Pencil size={14} aria-hidden />}
            onClick={run(onEdit)}
          >
            Edit
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
