import { useDeferredValue, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { relationshipQuery } from '../../api/queries';
import { searchQuery } from '../../api/search';
import type { ApiPersonSummary } from '../../api/types';
import { Combobox } from '../../components/Combobox/Combobox';
import { Dialog } from '../../components/Dialog/Dialog';
import { RelationshipChart } from '../../components/RelationshipChart/RelationshipChart';
import { formatLifespan } from '../../lib/lifespan';
import { fullName, lifeDate } from '../../lib/person';
import { relationshipCharts } from '../../lib/relationship';
import styles from './PersonPage.module.css';

function describe(person: ApiPersonSummary): string {
  const lifespan = formatLifespan({ birth: lifeDate(person.birth), death: lifeDate(person.death) });
  return lifespan ? `${fullName(person)} (${lifespan})` : fullName(person);
}

/** A person chosen by server search. */
function PersonPicker({
  tree,
  label,
  value,
  onChange,
}: {
  tree: string;
  label: string;
  value: ApiPersonSummary | null;
  onChange: (person: ApiPersonSummary) => void;
}) {
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim());
  const searching = /[\p{L}\p{N}]/u.test(q);
  const { data: hits = [] } = useQuery({
    ...searchQuery(tree, q, 10),
    enabled: searching,
    placeholderData: keepPreviousData,
  });
  const results = searching ? hits.map((hit) => hit.person) : [];
  return (
    <Combobox
      label={label}
      placeholder="Search by name, place or year"
      searchLabel={`Search people for ${label.toLowerCase()}`}
      emptyText={searching ? 'No matching people' : 'Type a name to search'}
      options={results.map((p) => ({ value: p.id, label: describe(p) }))}
      value={value?.id}
      selectedLabel={value ? describe(value) : undefined}
      onSearchChange={setQuery}
      onValueChange={(id) => {
        const person = results.find((p) => p.id === id);
        if (person) onChange(person);
      }}
    />
  );
}

export interface RelationshipCalculatorProps {
  tree: string;
  /** Prefilled first person (the page's person). */
  from: ApiPersonSummary;
  /** Prefilled second person (the home person), if any. */
  to: ApiPersonSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Any-to-any relationship: pick two people, read the name and one mini chart per path. */
export function RelationshipCalculator({
  tree,
  from: initialFrom,
  to: initialTo,
  open,
  onOpenChange,
}: RelationshipCalculatorProps) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const ready = !!to && to.id !== from.id;
  const { data, isFetching } = useQuery({
    ...relationshipQuery(tree, from.id, to?.id ?? ''),
    enabled: ready,
  });
  const found = data && ready ? relationshipCharts(data) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Relationship calculator" size="lg">
      <div className={styles.calculatorPickers}>
        <PersonPicker tree={tree} label="Person" value={from} onChange={setFrom} />
        <PersonPicker tree={tree} label="Related to" value={to} onChange={setTo} />
      </div>
      <div aria-live="polite" aria-busy={isFetching} data-testid="calculator-result">
        {!ready ? (
          <p className={styles.calculatorHint}>
            {to ? 'Choose two different people.' : 'Choose a second person.'}
          </p>
        ) : found ? (
          <>
            <p className={styles.calculatorName} data-testid="calculator-name">
              {found.name
                ? `${fullName(from)} is the ${found.name} of ${fullName(to!)}.`
                : data!.complete
                  ? `No relationship found between ${fullName(from)} and ${fullName(to!)}.`
                  : `No relationship found between ${fullName(from)} and ${fullName(to!)} within the search limits (40 generations).`}
            </p>
            {found.charts.length > 0 && (
              <RelationshipChart paths={found.charts} endCaption={null} />
            )}
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
