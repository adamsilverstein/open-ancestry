import { useMemo, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { Crosshair, Pencil, UserRound } from 'lucide-react';
import { cx } from '../../lib/cx';
import type { PersonSummary } from '../../lib/person';
import { Avatar } from '../Avatar/Avatar';
import { Button } from '../Button/Button';
import buttonStyles from '../Button/Button.module.css';
import { LifespanText } from '../LifespanText/LifespanText';
import { usePhoneLayout } from '../../lib/useMediaQuery';
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

/** Space kept between the popover and the screen edges. */
const EDGE = 8;
/** `--oa-topbar-height`: the sticky top bar the popover must not open under. */
const TOP_BAR_HEIGHT = 48;
/** The popover's width (see the CSS) plus its offset from the card. */
const NEEDED_BESIDE = 300 + 6 + EDGE;

/**
 * The tree's bottom toolbar in the phone layout (`--oa-tree-bottom-bar`, set
 * on the tree region), or 0.
 */
function bottomBarHeight(): number {
  const region = document.querySelector('[data-tree-region]') ?? document.documentElement;
  return Number.parseFloat(getComputedStyle(region).getPropertyValue('--oa-tree-bottom-bar')) || 0;
}

/**
 * Beside the card when there is room on the right (or the left); otherwise
 * below it, where Radix slides it sideways to fit and flips it above the card
 * when there is no room below. Decided from the space available, so it works
 * at any screen width, not at a fixed breakpoint.
 */
function placeSide(card: DOMRect): 'right' | 'left' | 'bottom' {
  if (window.innerWidth - card.right >= NEEDED_BESIDE) return 'right';
  if (card.left >= NEEDED_BESIDE) return 'left';
  return 'bottom';
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
  const firstAction = useRef<HTMLAnchorElement>(null);
  const phone = usePhoneLayout();
  if (!person || !anchor) return null;
  const side = open ? placeSide(anchor.getBoundingClientRect()) : 'right';
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
        side={side}
        align={side === 'bottom' ? 'center' : 'start'}
        // Keep clear of the sticky top bar as well as the screen edges.
        collisionPadding={{
          top: TOP_BAR_HEIGHT + EDGE,
          right: EDGE,
          bottom: (phone ? bottomBarHeight() : 0) + EDGE,
          left: EDGE,
        }}
        data-phone={phone || undefined}
        onOpenAutoFocus={(event) => {
          // Start on the first action rather than the dialog itself.
          event.preventDefault();
          firstAction.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          // No Radix trigger, so return focus to the card ourselves.
          if (!anchor.isConnected) return;
          event.preventDefault();
          anchor.focus();
        }}
      >
        <div className={styles.header}>
          <Avatar name={person.name} sex={person.sex} src={person.photoUrl} size={64} decorative />
          <div className={styles.title}>
            <p className={styles.name}>
              <PersonName name={person.name} />
            </p>
            <LifespanText className={styles.lifespan} {...person} />
          </div>
        </div>
        <div className={styles.events}>
          {eventLine('Born', birth)}
          {/* A living person's lifespan already ends in "Living". */}
          {!person.living && eventLine('Died', death)}
        </div>
        <div className={styles.actions}>
          <Link
            ref={firstAction}
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
