import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Network } from 'lucide-react';
import { ancestorsQuery, mediaUrl, treeQuery } from '../../api/queries';
import type { PersonDetail } from '../../api/types';
import { Avatar } from '../../components/Avatar/Avatar';
import buttonStyles from '../../components/Button/Button.module.css';
import { TagBadge } from '../../components/TagBadge/TagBadge';
import { cx } from '../../lib/cx';
import { fullName } from '../../lib/person';
import type { TagColor } from '../../lib/person';
import { describeRelationship } from '../../lib/relationship';
import { formatDate } from '@open-ancestry/core';
import type { EventBrief } from '../../api/types';
import styles from './PersonPage.module.css';

/** Stable tag color from its id, until tags carry a palette index. */
function tagColor(id: string): TagColor {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return ((hash % 8) + 1) as TagColor;
}

function Vital({ label, event }: { label: string; event: EventBrief | null }) {
  if (!event) return null;
  const date = event.dateText ? formatDate(event.dateText) : null;
  return (
    <p className={styles.vital}>
      <span className={styles.vitalLabel}>{label}</span>
      <span>{[date, event.place].filter(Boolean).join(' • ') || 'Unknown'}</span>
    </p>
  );
}

/** `father of Rowan Ashdown`, `Home person`, or null while loading or unrelated. */
function useRelationshipText(tree: string, detail: PersonDetail): string | null {
  const id = detail.person.id;
  const { data: info } = useQuery(treeQuery(tree));
  const home = info?.homePersonId ?? null;
  const spouseOfHome = detail.partnerFamilies.find((f) => f.partner?.id === home)?.partner;
  const needsAncestors = !!home && home !== id && !spouseOfHome;
  const homeAncestors = useQuery({ ...ancestorsQuery(tree, home ?? ''), enabled: needsAncestors });
  const personAncestors = useQuery({ ...ancestorsQuery(tree, id), enabled: needsAncestors });

  if (!home) return null;
  if (home === id) return 'Home person';
  if (spouseOfHome) {
    const role =
      detail.summary.sex === 'M' ? 'husband' : detail.summary.sex === 'F' ? 'wife' : 'spouse';
    return `${role} of ${fullName(spouseOfHome)}`;
  }
  if (!homeAncestors.data || !personAncestors.data) return null;
  const relationship = describeRelationship(homeAncestors.data, personAncestors.data);
  const homePerson = homeAncestors.data.people.find((p) => p.id === home);
  return relationship && homePerson ? `${relationship} of ${fullName(homePerson)}` : null;
}

export function PersonHeader({ tree, detail }: { tree: string; detail: PersonDetail }) {
  const { summary } = detail;
  const name = fullName(summary);
  const relationship = useRelationshipText(tree, detail);
  const sex = summary.sex === 'M' || summary.sex === 'F' ? summary.sex : 'U';
  return (
    <header className={styles.header} data-surface="canvas" data-testid="person-header">
      <Avatar
        name={name}
        sex={sex}
        size={120}
        src={summary.primaryMediaId ? mediaUrl(tree, summary.primaryMediaId) : undefined}
        className={styles.avatar}
      />
      <div className={styles.identity}>
        <h1 className={styles.name}>{name}</h1>
        <div className={styles.vitals}>
          <Vital label="Birth" event={summary.birth} />
          <Vital label="Death" event={summary.death} />
        </div>
        {/* Reserved line: filled when the relationship resolves, so nothing shifts. */}
        <p className={styles.relationship} data-testid="relationship">
          {relationship}
        </p>
        {detail.tags.length > 0 && (
          <ul className={styles.tags} aria-label="Tags">
            {detail.tags.map((tag) => (
              <li key={tag.id}>
                <TagBadge label={tag.name} color={tagColor(tag.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={styles.headerActions}>
        <Link
          to="/tree/$personId"
          params={{ personId: summary.id }}
          className={cx(buttonStyles.button, buttonStyles.secondary, buttonStyles.sm)}
        >
          <Network size={14} aria-hidden />
          View in tree
        </Link>
      </div>
    </header>
  );
}
