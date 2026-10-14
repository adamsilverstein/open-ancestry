import { useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { House, Moon, Palette, Sun, Users } from 'lucide-react';
import { useSearchPeople, type SearchHit } from '../api/search';
import { Avatar } from '../components/Avatar/Avatar';
import {
  CommandPalette,
  type PaletteAction,
  type PaletteGroup,
} from '../components/CommandPalette/CommandPalette';
import { formatLifespan } from '../lib/lifespan';
import { toPersonSummary } from '../lib/person';
import { useTheme } from '../lib/useTheme';

interface ShellCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
export default function ShellCommandPalette({ open, onOpenChange }: ShellCommandPaletteProps) {
  const navigate = useNavigate();
  const onTree = useRouterState({ select: (s) => s.location.pathname.startsWith('/tree/') });
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const [query, setQuery] = useState('');
  const { tree, hits, stale, pending } = useSearchPeople(query);

  const toPerson = (personId: string) => () =>
    void navigate({ to: '/person/$personId', params: { personId } });
  const toTree = (personId: string) => () =>
    void navigate({ to: '/tree/$personId', params: { personId } });

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
            onSelect: () => void navigate({ to: '/people' }),
          },
        ]
      : []),
    {
      id: 'home',
      label: 'Go to start page',
      icon: <House size={16} aria-hidden />,
      keywords: ['home', 'start'],
      onSelect: () => void navigate({ to: '/' }),
    },
    {
      id: 'design',
      label: 'Open design system',
      icon: <Palette size={16} aria-hidden />,
      keywords: ['design', 'system', 'components', 'kitchen sink'],
      onSelect: () => void navigate({ to: '/design' }),
    },
    {
      id: 'theme',
      label: `Switch to ${next} theme`,
      icon: next === 'dark' ? <Moon size={16} aria-hidden /> : <Sun size={16} aria-hidden />,
      keywords: ['theme', 'dark', 'light', 'appearance'],
      onSelect: toggle,
    },
  ];

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
