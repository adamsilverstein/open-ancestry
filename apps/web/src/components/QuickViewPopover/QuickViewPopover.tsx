import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { Crosshair, Pencil, UserRound } from 'lucide-react';
import { cx } from '../../lib/cx';
import type { PersonSummary } from '../../lib/person';
import { Avatar } from '../Avatar/Avatar';
import { Button } from '../Button/Button';
import buttonStyles from '../Button/Button.module.css';
import { LifespanText } from '../LifespanText/LifespanText';
import { Popover, PopoverAnchor, PopoverContent } from '../Popover/Popover';
import styles from './QuickViewPopover.module.css';
import { PersonName } from '../PersonName/PersonName';

export interface LifeEvent {
  /** Display date, e.g. `5 Sep 1911` or `abt. 1890`. */
  date?: string | undefined;
  place?: string | undefined;
}

/**
 * What the popover points at: a card element, or a virtual anchor for a
 * virtualized canvas whose card may be recycled while the popover is open.
 */
export interface QuickViewAnchor {
  getBoundingClientRect: () => DOMRect;
  focus: (options?: FocusOptions) => void;
  readonly isConnected: boolean;
}

export interface QuickViewPopoverProps {
  /** The person shown; null renders nothing. */
  person: PersonSummary | null;
  /** The card the popover points at. Focus returns to it on close. */
  anchor: QuickViewAnchor | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  birth?: LifeEvent | undefined;
  death?: LifeEvent | undefined;
  onMakeFocus?: (person: PersonSummary) => void;
  onEdit?: (person: PersonSummary) => void;
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

/**
 * Card click summary: photo, name, birth and death, and the main actions.
 *
 * One controlled instance serves a whole canvas: point `person` and `anchor`
 * at the clicked card instead of wrapping every card in its own popover.
 */
export function QuickViewPopover({
  person,
  anchor,
  open,
  onOpenChange,
  birth,
  death,
  onMakeFocus,
  onEdit,
}: QuickViewPopoverProps) {
  const virtualRef = useMemo(() => ({ current: anchor as QuickViewAnchor }), [anchor]);
  if (!person || !anchor) return null;
  const run = (action?: (p: PersonSummary) => void) => () => {
    onOpenChange(false);
    action?.(person);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        label={person.name}
        className={styles.content}
        side="right"
        align="start"
        onCloseAutoFocus={(event) => {
          // No Radix trigger, so return focus to the card ourselves.
          if (!anchor.isConnected) return;
          event.preventDefault();
          anchor.focus();
        }}
      >
        <div className={styles.header}>
          <Avatar name={person.name} sex={person.sex} src={person.photoUrl} size={64} decorative />
          <div>
            <p className={styles.name}>
              <PersonName name={person.name} />
            </p>
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
