import { useId } from 'react';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import type { PersonSummary } from '../../lib/person';
import { Avatar } from '../Avatar/Avatar';
import { Button } from '../Button/Button';
import { LifespanText } from '../LifespanText/LifespanText';
import styles from './RelationshipList.module.css';

export interface RelationshipGroup {
  title: string;
  people: PersonSummary[];
  /** Shows an add button labelled `addLabel`. */
  onAdd?: () => void;
  addLabel?: string;
}

export interface RelationshipListProps {
  groups: RelationshipGroup[];
  /** Heading level for group titles. */
  headingLevel?: 3 | 4;
}

function Group({ group, headingLevel }: { group: RelationshipGroup; headingLevel: 3 | 4 }) {
  const id = useId();
  const Heading = `h${headingLevel}` as const;
  return (
    <section aria-labelledby={id} className={styles.group}>
      <div className={styles.header}>
        <Heading id={id} className={styles.title}>
          {group.title}
        </Heading>
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
      <ul className={styles.list}>
        {group.people.map((person) => (
          <li key={person.id}>
            <Link to="/person/$personId" params={{ personId: person.id }} className={styles.row}>
              <Avatar
                name={person.name}
                sex={person.sex}
                src={person.photoUrl}
                size={40}
                decorative
              />
              <span className={styles.text}>
                <span className={styles.name}>{person.name}</span>
                <LifespanText className={styles.lifespan} {...person} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Grouped person rows (parents, spouses, children); every row links to that person. */
export function RelationshipList({ groups, headingLevel = 3 }: RelationshipListProps) {
  return (
    <div className={styles.root}>
      {groups.map((group) => (
        <Group key={group.title} group={group} headingLevel={headingLevel} />
      ))}
    </div>
  );
}
