import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Pencil, Plus, SlidersHorizontal, UserPlus } from 'lucide-react';
import { personQuery } from '../../api/queries';
import type { ApiPersonSummary, EventDetail, PersonDetail } from '../../api/types';
import { Button } from '../../components/Button/Button';
import { Checkbox } from '../../components/Checkbox/Checkbox';
import { EmptyState } from '../../components/EmptyState/EmptyState';
import { IconButton } from '../../components/IconButton/IconButton';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/Menu/Menu';
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
import { AddRelativeDialog, RELATIVE_TITLES, type RelativeKind } from './edit/AddRelativeDialog';
import { relationshipTypeLabel } from './edit/EditPersonDialog';
import { EventDialog } from './edit/EventDialog';
import { useRelationshipEdits } from './edit/RelationshipEdits';
import styles from './PersonPage.module.css';

const QUALITY = (q: number | null) =>
  q !== null && q >= 0 && q <= 3 ? (q as 0 | 1 | 2 | 3) : undefined;

function Entry({
  entry,
  variant,
  onEdit,
}: {
  entry: TimelineEntry;
  variant?: 'alternate';
  /** Own events are editable; relatives' events are edited on their page. */
  onEdit?: (() => void) | undefined;
}) {
  return (
    <TimelineItem
      actions={
        onEdit && (
          <IconButton
            label={
              variant === 'alternate'
                ? `Edit alternate ${entry.title}${entry.date ? ` (${entry.date})` : ''}`
                : `Edit ${entry.title}`
            }
            size="sm"
            icon={<Pencil size={14} aria-hidden />}
            onClick={onEdit}
          />
        )
      }
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

function TimelineColumn({
  detail,
  half,
  onEditEvent,
}: {
  detail: PersonDetail;
  half: ApiPersonSummary[];
  /** Opens the event dialog; no item means a new event. */
  onEditEvent: (item?: EventDetail) => void;
}) {
  const entries = useMemo(() => buildTimeline(detail, { halfSiblings: half }), [detail, half]);
  const eventsById = useMemo(
    () =>
      new Map(
        [...detail.events, ...detail.partnerFamilies.flatMap((f) => f.events)].map((e) => [
          e.event.id,
          e,
        ]),
      ),
    [detail],
  );
  const editFor = (entry: TimelineEntry) => {
    const item = entry.kind === 'own' ? eventsById.get(entry.id) : undefined;
    return item ? () => onEditEvent(item) : undefined;
  };
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
        <>
          <Button
            size="sm"
            variant="ghost"
            iconStart={<Plus size={14} aria-hidden />}
            onClick={() => onEditEvent()}
          >
            Add event
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                iconStart={<SlidersHorizontal size={14} aria-hidden />}
              >
                Filter events
                {hidden.size > 0 && (
                  <span className={styles.hiddenCount}>{hidden.size} hidden</span>
                )}
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
        </>
      }
    >
      {visible.length === 0 ? (
        <p className={styles.muted}>
          {entries.length === 0 ? 'No events recorded.' : 'All events are filtered out.'}
        </p>
      ) : (
        <ol className={styles.timelineList}>
          {visible.flatMap((entry) => [
            <Entry key={entry.id} entry={entry} onEdit={editFor(entry)} />,
            ...entry.alternates.map((alternate) => (
              <Entry
                key={alternate.id}
                entry={alternate}
                variant="alternate"
                onEdit={editFor(alternate)}
              />
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

type GroupMenus = Pick<ReturnType<typeof useRelationshipEdits>, 'parentMenu' | 'partnerMenu'>;

function relationshipGroups(
  detail: PersonDetail,
  half: ApiPersonSummary[],
  menus: GroupMenus,
): RelationshipGroup[] {
  const groups: RelationshipGroup[] = [];
  const seen = new Set<string>();
  detail.parentFamilies.forEach((family, index) => {
    const rel = family.link.partner1_rel;
    const title =
      index === 0
        ? 'Parents'
        : `Parents (${rel !== 'biological' && rel !== 'unknown' ? rel : index + 1})`;
    const parents = [family.partner1, family.partner2].filter((p) => p !== null);
    if (parents.length > 0)
      groups.push({
        title,
        people: parents.map((p) => toPersonSummary(p)),
        actions: menus.parentMenu(title, family),
      });
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
  for (const partnerFamily of detail.partnerFamilies) {
    const { family, partner, children } = partnerFamily;
    const name = many
      ? `Spouse and children: ${partner ? fullName(partner) : 'unknown partner'}`
      : 'Spouse and children';
    const title = groups.some((g) => g.title === name) ? `${name} (${family.id.slice(-4)})` : name;
    groups.push({
      title,
      subtitle: relationshipTypeLabel(family.relationship_type),
      people: partner ? [toPersonSummary(partner)] : [],
      nested: children.map((c) => toPersonSummary(c.person)),
      actions: menus.partnerMenu(title, partnerFamily),
    });
  }
  return groups;
}

function RelationshipsColumn({
  tree,
  detail,
  half,
  onAdd,
}: {
  tree: string;
  detail: PersonDetail;
  half: ApiPersonSummary[];
  onAdd: (kind: RelativeKind) => void;
}) {
  const { parentMenu, partnerMenu, dialogs } = useRelationshipEdits(tree, detail);
  const groups = relationshipGroups(detail, half, { parentMenu, partnerMenu });
  return (
    <Panel
      title="Relationships"
      className={styles.relationships}
      actions={
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" iconStart={<UserPlus size={14} aria-hidden />}>
              Add family member
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            {(Object.keys(RELATIVE_TITLES) as RelativeKind[]).map((kind) => (
              <MenuItem key={kind} onSelect={() => onAdd(kind)}>
                {RELATIVE_TITLES[kind]}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      }
    >
      {groups.length === 0 ? (
        <EmptyState title="No family recorded" level={3} />
      ) : (
        <RelationshipList groups={groups} />
      )}
      {dialogs}
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
  // Dialogs mount only while open, so each opening starts from fresh values.
  const [eventDialog, setEventDialog] = useState<{ item?: EventDetail | undefined } | null>(null);
  const [relative, setRelative] = useState<RelativeKind | null>(null);
  return (
    <div className={styles.facts}>
      <TimelineColumn
        detail={detail}
        half={half}
        onEditEvent={(item) => setEventDialog({ item })}
      />
      <SourcesColumn detail={detail} />
      <RelationshipsColumn tree={tree} detail={detail} half={half} onAdd={setRelative} />
      {eventDialog && (
        <EventDialog
          tree={tree}
          personId={detail.person.id}
          item={eventDialog.item}
          open
          onOpenChange={(open) => !open && setEventDialog(null)}
        />
      )}
      {relative && (
        <AddRelativeDialog
          tree={tree}
          detail={detail}
          kind={relative}
          open
          onOpenChange={(open) => !open && setRelative(null)}
        />
      )}
    </div>
  );
}
