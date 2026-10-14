import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { UserRound } from 'lucide-react';
import { CommandPalette } from '../components/CommandPalette/CommandPalette';
import { formatLifespan } from '../lib/lifespan';
import { searchPeople, treeKeys } from './api';
import { toPersonSummary } from './format';

interface FindDialogProps {
  tree: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (personId: string) => void;
}

/** "Find in tree": server-side people search; choosing a result re-focuses the tree. */
export function FindDialog({ tree, open, onOpenChange, onSelect }: FindDialogProps) {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const results = useQuery({
    queryKey: treeKeys.search(tree, q),
    queryFn: ({ signal }) => searchPeople(tree, q, signal),
    enabled: open && q.length > 0,
    placeholderData: keepPreviousData,
  });
  const items = (q ? (results.data ?? []) : []).map((hit) => {
    const person = toPersonSummary(hit, tree);
    const lifespan = formatLifespan(person);
    return {
      id: person.id,
      label: lifespan ? `${person.name} (${lifespan})` : person.name,
      icon: <UserRound size={16} aria-hidden />,
      onSelect: () => onSelect(person.id),
    };
  });
  return (
    <CommandPalette
      title="Find in tree"
      placeholder="Find a person in this tree"
      shouldFilter={false}
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
      onQueryChange={setQuery}
      groups={items.length > 0 ? [{ heading: 'People', items }] : []}
    />
  );
}
