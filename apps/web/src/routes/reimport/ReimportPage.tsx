import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateTree } from '../../api/edits';
import { treeQuery } from '../../api/queries';
import { Button } from '../../components/Button/Button';
import buttonStyles from '../../components/Button/Button.module.css';
import { Checkbox } from '../../components/Checkbox/Checkbox';
import { useToast } from '../../components/Toast/Toast';
import { cx } from '../../lib/cx';
import { useImportJob } from '../../library/useImportJob';
import importStyles from '../import/Import.module.css';
import {
  HIGH_CONFIDENCE,
  applyReimport,
  discardReimport,
  getReimport,
  type PersonReview,
  type ReimportReview,
  type ReviewChange,
} from './api';
import { describeChange } from './labels';
import styles from './Reimport.module.css';

/** People shown per page of the review. */
export const PAGE = 100;

const STATUS: Record<PersonReview['status'], string> = {
  matched: 'Matched',
  new: 'New person',
  missing: 'Not in the new export',
};

/** Changes that would be applied: chosen, applicable, and with every prerequisite chosen. */
function effective(review: ReimportReview, selected: Set<string>): Set<string> {
  const chosen = new Set(
    review.diff.people
      .flatMap((p) => p.changes)
      .filter((c) => c.applicable && selected.has(c.id))
      .map((c) => c.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of review.diff.people) {
      for (const c of p.changes) {
        if (chosen.has(c.id) && c.requires?.some((r) => !chosen.has(r))) {
          chosen.delete(c.id);
          changed = true;
        }
      }
    }
  }
  return chosen;
}

function PersonCard({
  person,
  active,
  onToggle,
}: {
  person: PersonReview;
  active: Set<string>;
  onToggle: (change: ReviewChange, on: boolean) => void;
}) {
  return (
    <section aria-label={person.name} className={styles.card} data-status={person.status}>
      <header className={styles.cardHeader}>
        <div>
          <h2 className={styles.name}>
            {person.name}
            {person.lifespan && <span className={styles.lifespan}> {person.lifespan}</span>}
          </h2>
          <p className={styles.meta}>
            {STATUS[person.status]}
            {person.confidence !== null && ` · ${Math.round(person.confidence * 100)}% match`}
            {person.confidence !== null &&
              person.confidence < HIGH_CONFIDENCE &&
              ' · check this match'}
            {person.reasons.length > 0 && ` · ${person.reasons.join(', ')}`}
          </p>
        </div>
      </header>
      <ul className={styles.changes}>
        {person.changes.map((change) => {
          const label = describeChange(change, person.name);
          if (!change.applicable) {
            return (
              <li key={change.id} className={styles.info}>
                {label}
                {change.kind === 'person.missing' && '. Kept in your tree.'}
              </li>
            );
          }
          const waiting = change.requires?.some((r) => !active.has(r)) ?? false;
          return (
            <li key={change.id}>
              <Checkbox
                label={label}
                checked={active.has(change.id)}
                disabled={waiting}
                description={
                  change.conflict === 'local-edit'
                    ? 'Edited in this tree since the last import; your edit is kept unless you tick this.'
                    : waiting
                      ? 'Needs the new person above.'
                      : undefined
                }
                onChange={(event) => onToggle(change, event.target.checked)}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Review({ review }: { review: ReimportReview }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const all = useMemo(() => review.diff.people.flatMap((p) => p.changes), [review]);
  const [selected, setSelected] = useState(
    () => new Set(all.filter((c) => c.applicable && c.defaultAccept).map((c) => c.id)),
  );
  const [pending, setPending] = useState(false);
  // A large export can change thousands of people: render cards in pages.
  const [shown, setShown] = useState(PAGE);
  const active = useMemo(() => effective(review, selected), [review, selected]);
  const { counts } = review.diff;

  function toggle(change: ReviewChange, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(change.id);
      else next.delete(change.id);
      return next;
    });
  }

  function acceptHighConfidence() {
    // Every change of confident matches and new people, but never over a local edit.
    setSelected(
      new Set(
        review.diff.people
          .filter((p) => p.status === 'new' || (p.confidence ?? 0) >= HIGH_CONFIDENCE)
          .flatMap((p) => p.changes)
          .filter((c) => c.applicable && c.conflict !== 'local-edit')
          .map((c) => c.id),
      ),
    );
  }

  async function apply() {
    setPending(true);
    try {
      const result = await applyReimport(review.id, [...active]);
      await invalidateTree(queryClient, review.tree);
      toast({
        title: `Applied ${result.applied} change${result.applied === 1 ? '' : 's'}`,
        description: 'Undo with Cmd/Ctrl-Z or from History.',
      });
      const tree = await queryClient.fetchQuery(treeQuery(review.tree));
      await (tree.homePersonId
        ? navigate({ to: '/tree/$personId', params: { personId: tree.homePersonId } })
        : navigate({ to: '/' }));
    } catch (error) {
      toast({
        title: 'Could not apply the re-import',
        description: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
      setPending(false);
    }
  }

  async function discard() {
    await discardReimport(review.id).catch(() => {});
    await navigate({ to: '/' });
  }

  return (
    <div className={cx(importStyles.page, styles.page)}>
      <header className={importStyles.header}>
        <div>
          <h1 className={importStyles.title}>Review the updated export</h1>
          <p className={importStyles.subtitle}>
            {review.fileName} compared with “{review.tree}”. Nothing changes until you apply.
          </p>
        </div>
      </header>
      <section aria-label="Summary" className={styles.summary}>
        <span>
          {counts.matched} matched ({counts.highConfidence} high confidence)
        </span>
        <span>{counts.changedPeople} with changes</span>
        <span>{counts.newPeople} new</span>
        <span>{counts.missingPeople} missing</span>
      </section>
      <div className={styles.toolbar}>
        <Button size="sm" onClick={acceptHighConfidence}>
          Accept all high-confidence
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
          Accept none
        </Button>
      </div>
      {review.diff.people.length === 0 ? (
        <p className={importStyles.note}>
          This export matches your tree: there is nothing to change.
        </p>
      ) : (
        <>
          {review.diff.people.slice(0, shown).map((person) => (
            <PersonCard key={person.key} person={person} active={active} onToggle={toggle} />
          ))}
          {review.diff.people.length > shown && (
            <Button onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, review.diff.people.length - shown)} more (
              {review.diff.people.length - shown} not shown; bulk choices include them)
            </Button>
          )}
        </>
      )}
      <div className={styles.footer}>
        <Button variant="ghost" onClick={() => void discard()}>
          Discard
        </Button>
        <Button
          variant="primary"
          disabled={pending || active.size === 0}
          onClick={() => void apply()}
        >
          Apply {active.size} change{active.size === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  );
}

/** Follows the comparison job, then shows the review. */
export function ReimportPage() {
  const { jobId } = useParams({ from: '/reimport/$jobId' });
  const { job, missing } = useImportJob(jobId);
  const result =
    job?.state === 'completed' ? (job.result as unknown as { reimportId: string }) : null;
  const { data: review, error } = useQuery({
    queryKey: ['reimport', result?.reimportId],
    queryFn: ({ signal }) => getReimport(result!.reimportId, signal),
    enabled: !!result,
    staleTime: Infinity,
    retry: false,
  });

  if (missing || error) {
    return (
      <div className={importStyles.page}>
        <h1 className={importStyles.title}>Re-import not found</h1>
        <p className={importStyles.note}>
          It may have expired or been applied already. Nothing was changed by it.
        </p>
        <Link to="/" className={cx(buttonStyles.button, buttonStyles.secondary, buttonStyles.md)}>
          Back home
        </Link>
      </div>
    );
  }
  if (job?.state === 'failed') {
    return (
      <div className={importStyles.page}>
        <h1 className={importStyles.title}>Re-import failed</h1>
        <p role="alert" className={importStyles.error}>
          {job.error ?? 'The comparison stopped with an unknown error.'}
        </p>
        <p className={importStyles.note}>Your tree was not changed.</p>
      </div>
    );
  }
  if (review) return <Review key={review.id} review={review} />;
  return (
    <div className={importStyles.page} aria-busy="true">
      <h1 className={importStyles.title}>
        {job ? `Comparing ${job.fileName} with your tree` : 'Starting the comparison'}
      </h1>
      <progress className={importStyles.progress} aria-label="Comparison progress" />
    </div>
  );
}
