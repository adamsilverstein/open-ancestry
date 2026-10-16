import { useId, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown, Plus } from 'lucide-react';
import { cx } from '../../lib/cx';
import type { PersonSummary } from '../../lib/person';
import { Avatar } from '../Avatar/Avatar';
import { Button } from '../Button/Button';
import { LifespanText } from '../LifespanText/LifespanText';
import styles from './RelationshipList.module.css';
import { PersonName } from '../PersonName/PersonName';

export interface RelationshipGroup {
  /** Unique within the list: it names the group's region. */
  title: string;
  people: PersonSummary[];
  /** People listed indented under `people`, e.g. a spouse's children. */
  nested?: PersonSummary[];
  /** Renders the title as a disclosure button that hides the rows. */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  /** Short qualifier under the title, e.g. the relationship type. */
  subtitle?: string | undefined;
  /** Controls at the end of the header, e.g. a menu of edits for the group. */
  actions?: ReactNode;
  /** Shows an add button labelled `addLabel`. */
  onAdd?: () => void;
  addLabel?: string;
}

export interface RelationshipListProps {
  groups: RelationshipGroup[];
  /** Heading level for group titles. */
  headingLevel?: 2 | 3 | 4;
}

function Row({ person }: { person: PersonSummary }) {
  return (
    <li>
      <Link
        to="/person/$personId"
        params={{ personId: person.id }}
        className={styles.row}
        data-name={person.name}
      >
        <Avatar name={person.name} sex={person.sex} src={person.photoUrl} size={40} decorative />
        <span className={styles.text}>
          <PersonName className={styles.name} name={person.name} />
          <LifespanText className={styles.lifespan} {...person} />
        </span>
      </Link>
    </li>
  );
}

function Group({ group, headingLevel }: { group: RelationshipGroup; headingLevel: 2 | 3 | 4 }) {
  const id = useId();
  const [collapsed, setCollapsed] = useState(group.defaultCollapsed ?? false);
  const Heading = `h${headingLevel}` as const;
  const count = group.people.length + (group.nested?.length ?? 0);
  const open = !group.collapsible || !collapsed;
  return (
    <section aria-labelledby={id} className={styles.group}>
      <div className={styles.header}>
        <Heading id={id} className={styles.title}>
          {group.collapsible ? (
            <button
              type="button"
              className={styles.toggle}
              aria-expanded={open}
              aria-controls={`${id}-list`}
              onClick={() => setCollapsed((c) => !c)}
            >
              <ChevronDown
                size={14}
                aria-hidden
                className={cx(styles.chevron, !open && styles.closed)}
              />
              {group.title} ({count})
            </button>
          ) : (
            group.title
          )}
        </Heading>
        {group.actions}
        {group.onAdd && (
          <Button
            size="sm"
            variant="ghost"
            iconStart={<Plus size={14} aria-hidden />}
            onClick={group.onAdd}
          >
            {group.addLabel ?? 'Add'}
          </Button>
        )}
      </div>
      {group.subtitle && <p className={styles.subtitle}>{group.subtitle}</p>}
      <div id={`${id}-list`} hidden={!open}>
        <ul className={styles.list}>
          {group.people.map((person) => (
            <Row key={person.id} person={person} />
          ))}
        </ul>
        {group.nested && group.nested.length > 0 && (
          <ul className={cx(styles.list, styles.nested)}>
            {group.nested.map((person) => (
              <Row key={person.id} person={person} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Grouped person rows (parents, siblings, spouses with children); every row links to that person. */
export function RelationshipList({ groups, headingLevel = 3 }: RelationshipListProps) {
  return (
    <div className={styles.root}>
      {groups.map((group) => (
        <Group key={group.title} group={group} headingLevel={headingLevel} />
      ))}
    </div>
  );
}
