import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Network, Pencil } from 'lucide-react';
import { ancestorsQuery, treeQuery } from '../../api/queries';
import { avatarUrl } from '../../lib/media';
import type { PersonDetail } from '../../api/types';
import { Avatar } from '../../components/Avatar/Avatar';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/Popover/Popover';
import { RelationshipChart } from '../../components/RelationshipChart/RelationshipChart';
import type { RelationshipChartCell } from '../../components/RelationshipChart/RelationshipChart';
import buttonStyles from '../../components/Button/Button.module.css';
import { Button } from '../../components/Button/Button';
import { TagBadge } from '../../components/TagBadge/TagBadge';
import { EditPersonDialog } from './edit/EditPersonDialog';
import { TagsEditor } from './edit/TagsEditor';
import { cx } from '../../lib/cx';
import { fullName, isLivingStatus, toPersonSummary } from '../../lib/person';
import type { TagColor } from '../../lib/person';
import { relationshipPath } from '../../lib/relationship';
import { formatDate } from '@open-ancestry/core';
import type { EventBrief } from '../../api/types';
import styles from './PersonPage.module.css';
import { PersonName } from '../../components/PersonName/PersonName';

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
  /** The home person's name after `text` ("father of "), shown isolated. */
  of?: string;
  /** One mini chart per connecting path, for blood relatives (several with pedigree collapse). */
  charts: { label: string; cells: RelationshipChartCell[] }[];
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

  if (!home) return { text: null, charts: [] };
  if (home === id) return { text: 'Home person', charts: [] };
  if (spouseOfHome) {
    const role =
      detail.summary.sex === 'M' ? 'husband' : detail.summary.sex === 'F' ? 'wife' : 'spouse';
    return { text: `${role} of `, of: fullName(spouseOfHome), charts: [] };
  }
  const people = new Map(
    [...(homeAncestors.data?.people ?? []), ...(personAncestors.data?.people ?? [])].map((p) => [
      p.id,
      p,
    ]),
  );
  const homePerson = people.get(home);
  if (!found || !homePerson) return { text: null, charts: [] };
  const charts = found.paths.map(({ label, cells }) => ({
    label,
    cells: cells.map((cell): RelationshipChartCell => {
      const person = people.get(cell.id);
      return { ...cell, person: person ? toPersonSummary(person) : null };
    }),
  }));
  return { text: `${found.name} of `, of: fullName(homePerson), charts };
}

export function PersonHeader({ tree, detail }: { tree: string; detail: PersonDetail }) {
  const { summary } = detail;
  const name = fullName(summary);
  const relationship = useRelationshipToHome(tree, detail);
  const sex = summary.sex === 'M' || summary.sex === 'F' ? summary.sex : 'U';
  const [editing, setEditing] = useState(false);
  return (
    <header className={styles.header} data-surface="canvas" data-testid="person-header">
      <Avatar
        name={name}
        sex={sex}
        size={120}
        // 120px: the 480px thumbnail keeps it sharp on 2x screens.
        src={avatarUrl(tree, summary, 'md')}
        className={styles.avatar}
      />
      <div className={styles.identity}>
        <h1 className={styles.name}>
          <PersonName name={name} />
        </h1>
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
            {/* Isolated, so a right-to-left name keeps "father of" in order. */}
            {relationship.of && <PersonName name={relationship.of} />}
          </p>
          {relationship.charts.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm">
                  Show path
                </Button>
              </PopoverTrigger>
              <PopoverContent label="Relationship path" className={styles.pathPopover}>
                <RelationshipChart paths={relationship.charts} />
              </PopoverContent>
            </Popover>
          )}
        </div>
        <div className={styles.tagRow}>
          {detail.tags.length > 0 && (
            <ul className={styles.tags} aria-label="Tags">
              {detail.tags.map((tag) => (
                <li key={tag.id}>
                  <TagBadge label={tag.name} color={tagColor(tag.id)} />
                </li>
              ))}
            </ul>
          )}
          <TagsEditor tree={tree} detail={detail} />
        </div>
      </div>
      <div className={styles.headerActions}>
        <Button
          size="sm"
          variant="secondary"
          iconStart={<Pencil size={14} aria-hidden />}
          onClick={() => setEditing(true)}
        >
          Edit person
        </Button>
        <Link
          to="/tree/$personId"
          params={{ personId: summary.id }}
          className={cx(buttonStyles.button, buttonStyles.secondary, buttonStyles.sm)}
        >
          <Network size={14} aria-hidden />
          View in tree
        </Link>
      </div>
      {editing && (
        <EditPersonDialog
          tree={tree}
          detail={detail}
          open
          onOpenChange={(open) => !open && setEditing(false)}
        />
      )}
    </header>
  );
}
