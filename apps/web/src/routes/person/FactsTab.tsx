import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { personQuery } from '../../api/queries';
import type { ApiPersonSummary, PersonDetail } from '../../api/types';
import { Button } from '../../components/Button/Button';
import { Checkbox } from '../../components/Checkbox/Checkbox';
import { EmptyState } from '../../components/EmptyState/EmptyState';
import { Panel } from '../../components/Panel/Panel';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/Popover/Popover';
import {
  RelationshipList,
  type RelationshipGroup,
} from '../../components/RelationshipList/RelationshipList';
import { SourceItem } from '../../components/SourceItem/SourceItem';
import { TimelineItem } from '../../components/TimelineItem/TimelineItem';
import { halfSiblings, parentIds } from '../../lib/halfSiblings';
import { fullName, toPersonSummary } from '../../lib/person';
import { collectCitations } from '../../lib/sources';
import {
  buildTimeline,
  filterTimeline,
  timelineCategories,
  type TimelineCategory,
  type TimelineEntry,
} from '../../lib/timeline';
import styles from './PersonPage.module.css';

const QUALITY = (q: number | null) =>
  q !== null && q >= 0 && q <= 3 ? (q as 0 | 1 | 2 | 3) : undefined;

function Entry({ entry, variant }: { entry: TimelineEntry; variant?: 'alternate' }) {
  return (
    <TimelineItem
      year={entry.year}
      age={entry.age}
      title={entry.title}
      date={entry.date}
      place={entry.place}
      sourceCount={entry.sourceCount}
      variant={variant ?? entry.kind}
    />
  );
}

function TimelineColumn({ detail, half }: { detail: PersonDetail; half: ApiPersonSummary[] }) {
  const entries = useMemo(() => buildTimeline(detail, { halfSiblings: half }), [detail, half]);
  const [hidden, setHidden] = useState<ReadonlySet<TimelineCategory>>(new Set());
  const visible = filterTimeline(entries, hidden);
  const toggle = (category: TimelineCategory, show: boolean) =>
    setHidden((current) => {
      const next = new Set(current);
      if (show) next.delete(category);
      else next.add(category);
      return next;
    });

  return (
    <Panel
      title="Timeline"
      className={styles.timeline}
      actions={
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              iconStart={<SlidersHorizontal size={14} aria-hidden />}
            >
              Filter events
              {hidden.size > 0 && <span className={styles.hiddenCount}>{hidden.size} hidden</span>}
            </Button>
          </PopoverTrigger>
          <PopoverContent label="Filter events" align="end">
            <div className={styles.filters}>
              {timelineCategories.map(({ id, label }) => (
                <Checkbox
                  key={id}
                  label={label}
                  checked={!hidden.has(id)}
                  onChange={(event) => toggle(id, event.currentTarget.checked)}
                />
              ))}
            </div>
          </PopoverContent>
        </Popover>
      }
    >
      {visible.length === 0 ? (
        <p className={styles.muted}>
          {entries.length === 0 ? 'No events recorded.' : 'All events are filtered out.'}
        </p>
      ) : (
        <ol className={styles.timelineList}>
          {visible.flatMap((entry) => [
            <Entry key={entry.id} entry={entry} />,
            ...entry.alternates.map((alternate) => (
              <Entry key={alternate.id} entry={alternate} variant="alternate" />
            )),
          ])}
        </ol>
      )}
    </Panel>
  );
}

function SourcesColumn({ detail }: { detail: PersonDetail }) {
  const cited = useMemo(() => collectCitations(detail), [detail]);
  return (
    <Panel title="Sources" className={styles.sources}>
      {cited.length === 0 ? (
        <p className={styles.muted}>No sources yet.</p>
      ) : (
        <ul className={styles.plainList}>
          {cited.map(({ detail: { citation, source }, citedFor, link }) => (
            <li key={citation.id}>
              <SourceItem
                title={source.title}
                citation={[citation.page, `Cited for ${citedFor.join(', ')}`]
                  .filter(Boolean)
                  .join(' · ')}
                quality={QUALITY(citation.quality)}
                externalUrl={link?.href}
                externalLabel={link?.label}
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function relationshipGroups(detail: PersonDetail, half: ApiPersonSummary[]): RelationshipGroup[] {
  const groups: RelationshipGroup[] = [];
  const seen = new Set<string>();
  detail.parentFamilies.forEach((family, index) => {
    const rel = family.link.partner1_rel;
    const title =
      index === 0
        ? 'Parents'
        : `Parents (${rel !== 'biological' && rel !== 'unknown' ? rel : index + 1})`;
    const parents = [family.partner1, family.partner2].filter((p) => p !== null);
    if (parents.length > 0) groups.push({ title, people: parents.map((p) => toPersonSummary(p)) });
  });
  const siblings = detail.parentFamilies
    .flatMap((f) => f.siblings.map((s) => s.person))
    .filter((p) => !seen.has(p.id) && seen.add(p.id));
  if (siblings.length > 0) {
    groups.push({
      title: 'Siblings',
      people: siblings.map((p) => toPersonSummary(p)),
      collapsible: true,
    });
  }
  if (half.length > 0) {
    groups.push({
      title: 'Half siblings',
      people: half.map((p) => toPersonSummary(p)),
      collapsible: true,
    });
  }
  const many = detail.partnerFamilies.length > 1;
  for (const { family, partner, children } of detail.partnerFamilies) {
    const title = many
      ? `Spouse and children: ${partner ? fullName(partner) : 'unknown partner'}`
      : 'Spouse and children';
    groups.push({
      title: groups.some((g) => g.title === title) ? `${title} (${family.id.slice(-4)})` : title,
      people: partner ? [toPersonSummary(partner)] : [],
      nested: children.map((c) => toPersonSummary(c.person)),
    });
  }
  return groups;
}

function RelationshipsColumn({ detail, half }: { detail: PersonDetail; half: ApiPersonSummary[] }) {
  const groups = useMemo(() => relationshipGroups(detail, half), [detail, half]);
  return (
    <Panel title="Relationships" className={styles.relationships}>
      {groups.length === 0 ? (
        <EmptyState title="No family recorded" level={3} />
      ) : (
        <RelationshipList groups={groups} />
      )}
    </Panel>
  );
}

/** Timeline, Sources and Relationships: three columns at lg, two at md, one below. */
const NONE: ApiPersonSummary[] = [];

/** All parent details, or null until every one has loaded. Module level so the result is memoized. */
const allDetails = (results: { data?: PersonDetail | undefined }[]) =>
  results.every((r) => r.data) ? results.map((r) => r.data as PersonDetail) : null;

/**
 * Half siblings come from the parents' other partnerships, which only the
 * parents' own details carry; they load after the page renders.
 */
function useHalfSiblings(tree: string, detail: PersonDetail): ApiPersonSummary[] {
  const parents = useQueries({
    queries: parentIds(detail).map((id) => personQuery(tree, id)),
    combine: allDetails,
  });
  return useMemo(() => (parents ? halfSiblings(detail, parents) : NONE), [detail, parents]);
}

export function FactsTab({ tree, detail }: { tree: string; detail: PersonDetail }) {
  const half = useHalfSiblings(tree, detail);
  return (
    <div className={styles.facts}>
      <TimelineColumn detail={detail} half={half} />
      <SourcesColumn detail={detail} />
      <RelationshipsColumn detail={detail} half={half} />
    </div>
  );
}
