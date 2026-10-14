import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Network } from 'lucide-react';
import { ancestorsQuery, mediaUrl, treeQuery } from '../../api/queries';
import type { PersonDetail } from '../../api/types';
import { Avatar } from '../../components/Avatar/Avatar';
import { Button } from '../../components/Button/Button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/Popover/Popover';
import { RelationshipChart } from '../../components/RelationshipChart/RelationshipChart';
import type { RelationshipChartCell } from '../../components/RelationshipChart/RelationshipChart';
import buttonStyles from '../../components/Button/Button.module.css';
import { TagBadge } from '../../components/TagBadge/TagBadge';
import { cx } from '../../lib/cx';
import { fullName, isLivingStatus, toPersonSummary } from '../../lib/person';
import type { TagColor } from '../../lib/person';
import { relationshipPath } from '../../lib/relationship';
import { formatDate } from '@open-ancestry/core';
import type { EventBrief } from '../../api/types';
import styles from './PersonPage.module.css';

/** Stable tag color from its id, until tags carry a palette index. */
function tagColor(id: string): TagColor {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return ((hash % 8) + 1) as TagColor;
}

function Vital({
  label,
  event,
  fallback,
}: {
  label: string;
  event: EventBrief | null;
  /** Shown when there is no event, e.g. `Living`. */
  fallback?: string | undefined;
}) {
  if (!event) {
    return fallback ? (
      <p className={styles.vital}>
        <span className={styles.vitalLabel}>{label}</span>
        <span>{fallback}</span>
      </p>
    ) : null;
  }
  const date = event.dateText ? formatDate(event.dateText) : null;
  return (
    <p className={styles.vital}>
      <span className={styles.vitalLabel}>{label}</span>
      <span>{[date, event.place].filter(Boolean).join(' • ') || 'Unknown'}</span>
    </p>
  );
}

interface RelationshipToHome {
  /** `father of Rowan Ashdown`, `Home person`; null while loading or unrelated. */
  text: string | null;
  /** The connecting path for the mini chart, for blood relatives. */
  chart: RelationshipChartCell[] | null;
}

function useRelationshipToHome(tree: string, detail: PersonDetail): RelationshipToHome {
  const id = detail.person.id;
  const { data: info } = useQuery(treeQuery(tree));
  const home = info?.homePersonId ?? null;
  const spouseOfHome = detail.partnerFamilies.find((f) => f.partner?.id === home)?.partner;
  const needsAncestors = !!home && home !== id && !spouseOfHome;
  const homeAncestors = useQuery({ ...ancestorsQuery(tree, home ?? ''), enabled: needsAncestors });
  const personAncestors = useQuery({ ...ancestorsQuery(tree, id), enabled: needsAncestors });
  const found = useMemo(
    () =>
      homeAncestors.data && personAncestors.data
        ? relationshipPath(homeAncestors.data, personAncestors.data)
        : null,
    [homeAncestors.data, personAncestors.data],
  );

  if (!home) return { text: null, chart: null };
  if (home === id) return { text: 'Home person', chart: null };
  if (spouseOfHome) {
    const role =
      detail.summary.sex === 'M' ? 'husband' : detail.summary.sex === 'F' ? 'wife' : 'spouse';
    return { text: `${role} of ${fullName(spouseOfHome)}`, chart: null };
  }
  const people = new Map(
    [...(homeAncestors.data?.people ?? []), ...(personAncestors.data?.people ?? [])].map((p) => [
      p.id,
      p,
    ]),
  );
  const homePerson = people.get(home);
  if (!found || !homePerson) return { text: null, chart: null };
  const chart = found.cells.map((cell): RelationshipChartCell => {
    const person = people.get(cell.id);
    return { ...cell, person: person ? toPersonSummary(person) : null };
  });
  return { text: `${found.name} of ${fullName(homePerson)}`, chart };
}

export function PersonHeader({ tree, detail }: { tree: string; detail: PersonDetail }) {
  const { summary } = detail;
  const name = fullName(summary);
  const relationship = useRelationshipToHome(tree, detail);
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
          <Vital
            label="Death"
            event={summary.death}
            fallback={isLivingStatus(summary.living) ? 'Living' : undefined}
          />
        </div>
        {/* Reserved line: filled when the relationship resolves, so nothing shifts. */}
        <div className={styles.relationshipRow}>
          <p className={styles.relationship} data-testid="relationship">
            {relationship.text}
          </p>
          {relationship.chart && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm">
                  Show path
                </Button>
              </PopoverTrigger>
              <PopoverContent label="Relationship path" className={styles.pathPopover}>
                <RelationshipChart cells={relationship.chart} />
              </PopoverContent>
            </Popover>
          )}
        </div>
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
