import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { CircleHelp, TriangleAlert } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { invalidateTree } from '../../api/edits';
import { treeQuery } from '../../api/queries';
import { Button } from '../../components/Button/Button';
import buttonStyles from '../../components/Button/Button.module.css';
import { Checkbox } from '../../components/Checkbox/Checkbox';
import { useToast } from '../../components/Toast/Toast';
import { cx } from '../../lib/cx';
import { cancelJob, getJob } from '../../library/api';
import { useImportJob } from '../../library/useImportJob';
import importStyles from '../import/Import.module.css';
import {
  HIGH_CONFIDENCE,
  applyReimport,
  discardReimport,
  getReimport,
  getReimportStatus,
  refreshReimport,
  type PersonReview,
  type ReimportReview,
  type ReviewChange,
} from './api';
import { groupReview, QUESTIONS, type GroupId } from './group';
import { compareProgress, conflictText, describeChange } from './labels';
import styles from './Reimport.module.css';

/** People shown per page of the review. */
export const PAGE = 100;

const STATUS: Record<PersonReview['status'], string> = {
  matched: 'Matched',
  new: 'New person',
  missing: 'Not in the new export',
};

/** What a change says, without its per-comparison ids: equal only if nothing about it changed. */
function contentOf(change: ReviewChange): string {
  const { id: _id, requires: _requires, defaultAccept: _default, ...rest } = change;
  void _id;
  void _requires;
  void _default;
  return JSON.stringify(rest);
}

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
  // An article per card: the four groups stay the only regions (landmarks).
  return (
    // Named by the person alone (the heading also shows their lifespan).
    <article aria-label={person.name} className={styles.card} data-status={person.status}>
      <header className={styles.cardHeader}>
        <div>
          <h3 className={styles.name}>
            {person.name}
            {person.lifespan && <span className={styles.lifespan}> {person.lifespan}</span>}
          </h3>
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
                {QUESTIONS.has(change.kind) && (
                  <span className={styles.flag}>
                    <CircleHelp aria-hidden size={14} /> Check
                  </span>
                )}
                {label}
                {change.kind === 'person.missing' && '. Kept in your tree.'}
              </li>
            );
          }
          const waiting = change.requires?.some((r) => !active.has(r)) ?? false;
          return (
            <li key={change.id} className={change.conflict ? styles.conflict : undefined}>
              <Checkbox
                label={label}
                checked={active.has(change.id)}
                disabled={waiting}
                description={
                  change.conflict ? (
                    // The marker opens the description, so it is announced with the checkbox (#194),
                    // followed by what ticking does (#201).
                    <>
                      <span className={styles.flag}>
                        <TriangleAlert aria-hidden size={14} /> Conflict
                      </span>
                      {conflictText(change, person.name)}
                    </>
                  ) : waiting ? (
                    'Needs the new person above.'
                  ) : undefined
                }
                onChange={(event) => onToggle(change, event.target.checked)}
              />
            </li>
          );
        })}
      </ul>
    </article>
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
  const [stale, setStale] = useState(review.stale);
  const [comparing, setComparing] = useState(false);
  // A large export can change thousands of people: render cards in pages.
  const [shown, setShown] = useState(PAGE);
  const [filter, setFilter] = useState<GroupId | 'all'>('all');
  const groups = useMemo(() => groupReview(review.diff.people), [review]);
  const visible = groups.filter((g) => g.people.length && (filter === 'all' || g.id === filter));
  const listed = visible.reduce((n, g) => n + g.people.length, 0);
  // Matched people without a card: nothing in the export changed them.
  const unchanged = Math.max(
    0,
    review.diff.counts.matched - review.diff.people.filter((p) => p.status === 'matched').length,
  );
  const active = useMemo(() => effective(review, selected), [review, selected]);
  const { counts } = review.diff;

  // Edits elsewhere (another tab) make the review stale: check whenever the page is back in view.
  useEffect(() => {
    let current = true;
    let last = 0;
    const check = () => {
      // Focus and visibilitychange usually fire together: ask once.
      if (document.visibilityState === 'hidden' || Date.now() - last < 250) return;
      last = Date.now();
      getReimportStatus(review.id, review.comparison)
        .then((status) => current && setStale(status.stale))
        .catch(() => {});
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      current = false;
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [review.id, review.comparison]);

  /**
   * Compares the export again and keeps every choice the user made: a change
   * that still says exactly the same thing keeps a tick that differs from its
   * old default; anything else takes its new default, so a choice never
   * carries over onto a value the user hasn't seen.
   */
  async function compareAgain() {
    setComparing(true);
    try {
      const fresh = await refreshReimport(review.id);
      const chosen = new Map(
        all
          .filter((c) => c.applicable && selected.has(c.id) !== c.defaultAccept)
          .map((c) => [c.key, { on: selected.has(c.id), content: contentOf(c) }]),
      );
      const keep = (c: ReviewChange) => {
        const before = chosen.get(c.key);
        return before && before.content === contentOf(c) ? before.on : c.defaultAccept;
      };
      const next = new Set(
        fresh.diff.people
          .flatMap((p) => p.changes)
          .filter((c) => c.applicable && keep(c))
          .map((c) => c.id),
      );
      queryClient.setQueryData(['reimport', review.id], fresh);
      setSelected(next);
      setStale(fresh.stale);
    } catch (error) {
      toast({
        title: 'Could not compare again',
        description: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    } finally {
      setComparing(false);
    }
  }

  function toggle(change: ReviewChange, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(change.id);
      else next.delete(change.id);
      return next;
    });
  }

  function acceptHighConfidence() {
    // Every change of confident matches, but never over a local edit or delete; new
    // people as suggested (a possible duplicate or a deleted person stays unticked).
    setSelected(
      new Set(
        review.diff.people
          .filter((p) => p.status === 'new' || (p.confidence ?? 0) >= HIGH_CONFIDENCE)
          .flatMap((p) =>
            p.changes.filter(
              (c) => c.applicable && !c.conflict && (p.status !== 'new' || c.defaultAccept),
            ),
          )
          .map((c) => c.id),
      ),
    );
  }

  async function apply() {
    setPending(true);
    try {
      const result = await applyReimport(review.id, review.comparison, [...active]);
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
      setPending(false);
      // The tree moved since the comparison: offer to compare again instead.
      if (error instanceof ApiError && error.status === 409) {
        setStale(true);
        return;
      }
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
      {stale && (
        <div role="alert" className={styles.stale}>
          <p>
            Your tree changed since this comparison, so it can't be applied as it is. Compare again
            to see what the export would change now; the choices you made are kept.
          </p>
          <Button size="sm" disabled={comparing} onClick={() => void compareAgain()}>
            {comparing ? 'Comparing…' : 'Compare again'}
          </Button>
        </div>
      )}
      <section aria-label="Summary" className={styles.summary}>
        <span>
          In the export: {counts.matched} matched ({unchanged} unchanged, not listed)
        </span>
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
          <div role="group" aria-label="Filter the review" className={styles.filters}>
            {[
              { id: 'all' as const, title: 'All', count: review.diff.people.length },
              ...groups
                .filter((g) => g.people.length)
                .map((g) => ({ id: g.id, title: g.title, count: g.people.length })),
            ].map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant="secondary"
                className={styles.filter}
                aria-pressed={filter === f.id}
                onClick={() => {
                  setFilter(f.id);
                  setShown(PAGE);
                }}
              >
                {f.title} {f.count}
              </Button>
            ))}
          </div>
          {(() => {
            // Pages run through the groups in reading order.
            let left = shown;
            return visible.map((g) => {
              const people = g.people.slice(0, Math.max(0, left));
              left -= people.length;
              if (!people.length) return null;
              return (
                <section
                  key={g.id}
                  aria-labelledby={`group-${g.id}`}
                  data-group={g.id}
                  className={styles.group}
                >
                  <h2 id={`group-${g.id}`} className={styles.groupTitle}>
                    {g.id === 'decide' && <TriangleAlert aria-hidden size={18} />}
                    {g.title} ({g.people.length})
                  </h2>
                  {people.map((person) => (
                    <PersonCard
                      key={person.key}
                      person={person}
                      active={active}
                      onToggle={toggle}
                    />
                  ))}
                </section>
              );
            });
          })()}
          {listed > shown && (
            <Button onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, listed - shown)} more ({listed - shown} not shown; bulk choices
              include them)
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
          disabled={pending || stale || active.size === 0}
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
  const navigate = useNavigate();
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
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

  /** Stops the comparison, or discards its review if it finished in the meantime. */
  async function cancel() {
    setCancelling(true);
    // False (409): the comparison already finished, so discard its review.
    if (!(await cancelJob(jobId).catch(() => false))) {
      const latest = await getJob(jobId).catch(() => null);
      const done = latest?.result as unknown as { reimportId?: string } | undefined;
      if (done?.reimportId) await discardReimport(done.reimportId).catch(() => {});
    }
    toast({ title: 'Re-import cancelled. Your tree was not changed.' });
    await navigate({ to: '/' });
  }

  return (
    <div className={importStyles.page} aria-busy="true">
      <h1 className={importStyles.title}>
        {job ? `Comparing ${job.fileName} with your tree` : 'Starting the comparison'}
      </h1>
      <progress
        className={importStyles.progress}
        aria-label="Comparison progress"
        {...(job?.progress?.phase === 'map' &&
          job.progress.total > 0 && { value: job.progress.done / job.progress.total, max: 1 })}
      />
      <p className={importStyles.note} aria-live="polite">
        {job?.state === 'queued'
          ? 'Waiting for another import to finish'
          : compareProgress(job?.progress)}
      </p>
      <div>
        <Button variant="secondary" disabled={cancelling} onClick={() => void cancel()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
