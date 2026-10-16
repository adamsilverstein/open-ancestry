import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Ellipsis, House, Network, Pencil, Route } from 'lucide-react';
import { apiSend, seg } from '../../api/client';
import { useEdit } from '../../api/edits';
import { relationshipQuery, treeQuery } from '../../api/queries';
import { avatarUrl } from '../../lib/media';
import type { PersonDetail } from '../../api/types';
import { IconButton } from '../../components/IconButton/IconButton';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/Menu/Menu';
import { useToast } from '../../components/Toast/Toast';
import { Avatar } from '../../components/Avatar/Avatar';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/Popover/Popover';
import { RelationshipChart } from '../../components/RelationshipChart/RelationshipChart';
import type { RelationshipChartPath } from '../../components/RelationshipChart/RelationshipChart';
import buttonStyles from '../../components/Button/Button.module.css';
import { Button } from '../../components/Button/Button';
import { TagBadge } from '../../components/TagBadge/TagBadge';
import { EditPersonDialog } from './edit/EditPersonDialog';
import { TagsEditor } from './edit/TagsEditor';
import { cx } from '../../lib/cx';
import { fullName, isLivingStatus } from '../../lib/person';
import type { TagColor } from '../../lib/person';
import { relationshipCharts } from '../../lib/relationship';
import { RelationshipCalculator } from './RelationshipCalculator';
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
  /** One mini chart per connecting path (several with pedigree collapse). */
  charts: RelationshipChartPath[];
}

/** The person's relationship to the home person, named by the server over the whole tree. */
function useRelationshipToHome(tree: string, detail: PersonDetail): RelationshipToHome {
  const id = detail.person.id;
  const { data: info } = useQuery(treeQuery(tree));
  const home = info?.homePersonId ?? null;
  const { data } = useQuery({
    ...relationshipQuery(tree, id, home ?? ''),
    enabled: !!home && home !== id,
  });
  if (!home) return { text: null, charts: [] };
  if (home === id) return { text: 'Home person', charts: [] };
  const homePerson = data?.people.find((p) => p.id === home);
  if (!data || !homePerson) return { text: null, charts: [] };
  const { name, charts } = relationshipCharts(data);
  if (name) return { text: `${name} of ${fullName(homePerson)}`, charts };
  // The search stopped at its limits: say so rather than look unrelated.
  return data.complete
    ? { text: null, charts: [] }
    : {
        text: `No relationship to ${fullName(homePerson)} found within the search limits`,
        charts: [],
      };
}

/** "Set as home person": an undoable edit that re-bases every relationship line. */
function useSetHome(tree: string, detail: PersonDetail) {
  const edit = useEdit(tree);
  const toast = useToast();
  const name = fullName(detail.summary);
  return () =>
    edit.mutate({
      label: 'Set home person',
      send: () => apiSend('PUT', `/trees/${seg(tree)}/home`, { personId: detail.person.id }),
      onDone: () =>
        toast({
          title: `${name} is now the home person`,
          description: 'Undo from History or with Ctrl+Z (⌘Z on a Mac).',
        }),
    });
}

export function PersonHeader({ tree, detail }: { tree: string; detail: PersonDetail }) {
  const { summary } = detail;
  const name = fullName(summary);
  const nickname = (
    detail.names.find((n) => n.is_primary === 1) ?? detail.names[0]
  )?.nickname?.trim();
  const relationship = useRelationshipToHome(tree, detail);
  const sex = summary.sex === 'M' || summary.sex === 'F' ? summary.sex : 'U';
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  // `?edit=true` (the tree's quick view Edit) opens the editor on arrival.
  const { edit } = useSearch({ from: '/person/$personId' });
  const navigate = useNavigate({ from: '/person/$personId' });
  const closeEditor = () => {
    setEditing(false);
    // Drop the flag, so reloading or going back to this page does not reopen it.
    if (edit) void navigate({ search: (prev) => ({ ...prev, edit: undefined }), replace: true });
  };
  const [calculating, setCalculating] = useState(false);
  const setHome = useSetHome(tree, detail);
  const { data: info } = useQuery(treeQuery(tree));
  const isHome = info?.homePersonId === summary.id;
  const { data: home } = useQuery({
    ...relationshipQuery(tree, summary.id, info?.homePersonId ?? ''),
    enabled: !!info?.homePersonId && !isHome,
  });
  const homeSummary = home?.people.find((p) => p.id === info?.homePersonId) ?? null;
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
        <h1 className={styles.name}>{name}</h1>
        {/* The primary name's nickname, saved in Edit person but shown nowhere before (#280). */}
        {nickname && (
          <p className={styles.nickname} data-testid="nickname">
            Known as “{nickname}”
          </p>
        )}
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
          ref={editButton}
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
        {/* Not modal: the calculator dialog opens from it and must own focus. */}
        <Menu modal={false}>
          <MenuTrigger asChild>
            <IconButton
              label="More actions"
              icon={<Ellipsis size={16} aria-hidden />}
              size="sm"
              variant="secondary"
              tooltip={false}
            />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => setCalculating(true)}>
              <Route size={14} aria-hidden /> Relationship to…
            </MenuItem>
            <MenuItem disabled={isHome} onSelect={setHome}>
              <House size={14} aria-hidden /> {isHome ? 'Home person' : 'Set as home person'}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {calculating && (
        <RelationshipCalculator
          tree={tree}
          from={summary}
          to={homeSummary}
          open
          onOpenChange={(open) => !open && setCalculating(false)}
        />
      )}
      {(editing || edit) && (
        <EditPersonDialog
          tree={tree}
          detail={detail}
          open
          onOpenChange={(open) => !open && closeEditor()}
          // Opened from a link (?edit=true) there is no button to return to.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            editButton.current?.focus();
          }}
        />
      )}
    </header>
  );
}
