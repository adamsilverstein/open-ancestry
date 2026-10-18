import { useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { House, ListChecks, Moon, Palette, Sun, Tags, UserPlus, Users } from 'lucide-react';
import { useAddPerson } from './addPerson';
import {
  PALETTE_ALL_RESULTS,
  PALETTE_RESULTS,
  useSearchPeople,
  type SearchHit,
} from '../api/search';
import { Avatar } from '../components/Avatar/Avatar';
import {
  CommandPalette,
  type PaletteAction,
  type PaletteGroup,
  type TypeAhead,
} from '../components/CommandPalette/CommandPalette';
import { focusMainHeading } from '../lib/focusHeading';
import { formatLifespan } from '../lib/lifespan';
import { toPersonSummary } from '../lib/person';
import { useTheme } from '../lib/useTheme';

interface ShellCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Keys typed before the input took focus, to start the query with. */
  takeTypeAhead?: () => TypeAhead;
}

/** "1850–1921 · Kestrel Cove, Saltmarsh" */
function personDescription(hit: SearchHit): string {
  const summary = toPersonSummary(hit.person);
  return [formatLifespan(summary), hit.person.birth?.place].filter(Boolean).join(' · ');
}

/**
 * App-level palette: people in the open tree (server search) and app actions.
 * Enter opens the person page and Shift/Alt+Enter focuses them in the tree;
 * on the tree view ("Find in tree") the two swap.
 */
export default function ShellCommandPalette({
  open,
  onOpenChange,
  takeTypeAhead,
}: ShellCommandPaletteProps) {
  const navigate = useNavigate();
  const onTree = useRouterState({ select: (s) => s.location.pathname.startsWith('/tree/') });
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const [query, setQuery] = useState('');
  // "Show all N people" widens this query only; new text starts at the short list again.
  const [allFor, setAllFor] = useState<string | null>(null);
  const showAll = allFor !== null && allFor === query;
  const { tree, hits, total, stale, pending } = useSearchPeople(
    query,
    showAll ? PALETTE_ALL_RESULTS : PALETTE_RESULTS,
  );
  const addPerson = useAddPerson();

  // Opening a page moves focus to its heading, so a screen reader announces it (#200).
  const openPage = (go: Promise<unknown>) => go.then(focusMainHeading);
  const toPerson = (personId: string) => () =>
    openPage(navigate({ to: '/person/$personId', params: { personId } }));
  // From the tree, keep its view (tree, layout, generations) while re-focusing.
  const toTree = (personId: string) => () => {
    const go = navigate({
      to: '/tree/$personId',
      params: { personId },
      search: (prev: Record<string, unknown>) => (onTree ? prev : {}),
    });
    // Arriving at the tree from another page announces it like any page; Find
    // in tree (already on it) leaves focus to the tree's own re-focus.
    return onTree ? void go : openPage(go);
  };

  const people: PaletteAction[] = hits.map((hit) => {
    const summary = toPersonSummary(hit.person);
    return {
      id: `person:${hit.person.id}`,
      label: summary.name,
      description: personDescription(hit),
      icon: <Avatar name={summary.name} sex={summary.sex} size={24} decorative />,
      onSelect: onTree ? toTree(hit.person.id) : toPerson(hit.person.id),
      onAltSelect: onTree ? toPerson(hit.person.id) : toTree(hit.person.id),
      // Results for the previous query stay visible, dimmed, until fresh ones arrive.
      disabled: stale,
    };
  });

  const actions: PaletteAction[] = [
    ...(tree
      ? [
          {
            id: 'people',
            label: 'Open people list',
            icon: <Users size={16} aria-hidden />,
            keywords: ['people', 'list', 'everyone', 'table'],
            onSelect: () => openPage(navigate({ to: '/people' })),
          },
          {
            id: 'checker',
            label: 'Open tree checker',
            icon: <ListChecks size={16} aria-hidden />,
            keywords: ['check', 'checker', 'problems', 'duplicates', 'errors', 'sources'],
            onSelect: () => openPage(navigate({ to: '/checker' })),
          },
          {
            id: 'tags',
            label: 'Manage tags',
            icon: <Tags size={16} aria-hidden />,
            keywords: ['tags', 'mytreetags', 'categories', 'labels'],
            onSelect: () => void navigate({ to: '/tags' }),
          },
          {
            id: 'add-person',
            label: 'Add person',
            icon: <UserPlus size={16} aria-hidden />,
            keywords: ['add', 'new', 'person', 'create', 'individual'],
            onSelect: addPerson.open,
          },
        ]
      : []),
    {
      id: 'home',
      label: 'Go to start page',
      icon: <House size={16} aria-hidden />,
      keywords: ['home', 'start'],
      onSelect: () => openPage(navigate({ to: '/' })),
    },
    {
      id: 'design',
      label: 'Open design system',
      icon: <Palette size={16} aria-hidden />,
      keywords: ['design', 'system', 'components', 'kitchen sink'],
      onSelect: () => openPage(navigate({ to: '/design' })),
    },
    {
      id: 'theme',
      label: `Switch to ${next} theme`,
      icon: next === 'dark' ? <Moon size={16} aria-hidden /> : <Sun size={16} aria-hidden />,
      keywords: ['theme', 'dark', 'light', 'appearance'],
      onSelect: toggle,
    },
  ];

  // Say there are more than the short list shows, and offer them (#280).
  if (!stale && hits.length > 0 && total > hits.length && !showAll) {
    people.push({
      id: 'people:all',
      // The palette lists at most PALETTE_ALL_RESULTS: say so rather than promise all.
      label:
        total > PALETTE_ALL_RESULTS
          ? `Show the first ${PALETTE_ALL_RESULTS} of ${total.toLocaleString()} people`
          : `Show all ${total} people`,
      keepOpen: true,
      onSelect: () => setAllFor(query),
    });
  }
  const groups: PaletteGroup[] = [
    ...(people.length > 0 ? [{ heading: 'People', items: people, unfiltered: true }] : []),
    { heading: 'Actions', items: actions },
  ];

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      onQueryChange={setQuery}
      takeTypeAhead={takeTypeAhead}
      placeholder={onTree ? 'Find in tree, or search actions' : 'Search people, places, actions'}
      loading={pending && people.length === 0}
      pending={pending}
      footer={
        people.length > 0 && !stale ? (
          <>
            <span>
              <kbd>Enter</kbd> {onTree ? 'show in tree' : 'open person'}
            </span>
            <span>
              <kbd>Shift+Enter</kbd> {onTree ? 'open person' : 'show in tree'}
            </span>
          </>
        ) : undefined
      }
    />
  );
}
