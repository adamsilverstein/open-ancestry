import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BookX, CalendarX, Copy, EyeOff, ListChecks } from 'lucide-react';
import {
  CHECK_ITEM_LIMIT,
  checksQuery,
  type CheckCategory,
  type CheckIssue,
} from '../../api/checks';
import { apiSend, seg } from '../../api/client';
import { useEdit } from '../../api/edits';
import { currentTreeQuery } from '../../api/queries';
import { Button } from '../../components/Button/Button';
import { EmptyState } from '../../components/EmptyState/EmptyState';
import { LifespanText } from '../../components/LifespanText/LifespanText';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/Tabs/Tabs';
import { fullName, toPersonSummary } from '../../lib/person';
import styles from './CheckerPage.module.css';

type Tab = CheckCategory | 'dismissed';

const TABS: { id: Tab; label: string; empty: string; icon: typeof Copy }[] = [
  { id: 'duplicates', label: 'Possible duplicates', empty: 'No possible duplicates.', icon: Copy },
  { id: 'dates', label: 'Impossible dates', empty: 'No impossible dates.', icon: CalendarX },
  { id: 'sources', label: 'No sources', empty: 'Everyone has a source.', icon: BookX },
  { id: 'dismissed', label: 'Dismissed', empty: 'Nothing dismissed.', icon: EyeOff },
];

function IssueRow({
  issue,
  dismissed,
  onToggle,
}: {
  issue: CheckIssue;
  dismissed: boolean;
  onToggle: (issue: CheckIssue) => void;
}) {
  const Icon = TABS.find((t) => t.id === issue.category)?.icon ?? ListChecks;
  return (
    <li className={styles.issue}>
      <Icon size={18} aria-hidden className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.message}>{issue.message}</p>
        <ul className={styles.people} aria-label="People">
          {issue.people.map((person) => {
            const summary = toPersonSummary(person);
            return (
              <li key={person.id}>
                <Link to="/person/$personId" params={{ personId: person.id }}>
                  {fullName(person)}
                </Link>{' '}
                <LifespanText className={styles.lifespan} {...summary} />
              </li>
            );
          })}
        </ul>
      </div>
      {issue.kind === 'possible-duplicate' && !dismissed && issue.people.length === 2 && (
        <Link
          to="/merge"
          search={{ keep: issue.people[0]!.id, other: issue.people[1]!.id }}
          className={styles.mergeLink}
        >
          Compare and merge
        </Link>
      )}
      <Button size="sm" variant="ghost" onClick={() => onToggle(issue)}>
        {dismissed ? 'Restore' : 'Dismiss'}
      </Button>
    </li>
  );
}

function CheckerSkeleton() {
  return (
    <div aria-busy="true" className={styles.list}>
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} height={64} />
      ))}
    </div>
  );
}

/** Tree checker (#57): problems worth a look, each dismissable and undoable. */
export function CheckerPage() {
  const { data: tree } = useQuery(currentTreeQuery);
  const report = useQuery({ ...checksQuery(tree ?? ''), enabled: !!tree });
  const edit = useEdit(tree ?? '');

  const toggle = (issue: CheckIssue, dismiss: boolean) =>
    edit.mutate({
      label: dismiss ? 'Dismiss check' : 'Restore check',
      send: () =>
        apiSend('POST', `/trees/${seg(tree!)}/checks/${dismiss ? 'dismiss' : 'restore'}`, {
          keys: [issue.key],
        }),
    });

  if (tree === null) {
    return (
      <div className={styles.page}>
        <EmptyState level={1} title="No tree open" description="Import a GEDCOM file first." />
      </div>
    );
  }

  const data = report.data;
  const listFor = (tab: Tab) =>
    !data
      ? []
      : tab === 'dismissed'
        ? data.dismissed
        : data.items.filter((i) => i.category === tab);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Tree checker</h1>
        <p className={styles.intro}>
          Possible duplicates, dates that cannot be right, and people without sources. Dismiss
          anything that is fine; you can undo or restore it later.
        </p>
      </header>
      <Tabs defaultValue="duplicates">
        <TabsList aria-label="Checks" className={styles.tabs}>
          {TABS.map(({ id, label }) => (
            <TabsTrigger key={id} value={id}>
              {label}
              <span className={styles.count}>{data ? data.counts[id] : '–'}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map(({ id, empty }) => {
          const list = listFor(id);
          const total = data?.counts[id] ?? 0;
          return (
            <TabsContent key={id} value={id}>
              {id === 'duplicates' && (
                <p className={styles.note}>
                  People match when any of their names share a first given name and a sound-alike
                  surname, and their birth or death dates agree within a few years. Spelling
                  variants of a given name, such as Wm and William, are not matched.
                </p>
              )}
              {!data ? (
                <CheckerSkeleton />
              ) : list.length === 0 ? (
                <p className={styles.empty}>{empty}</p>
              ) : (
                <>
                  {total > list.length && (
                    <p className={styles.note}>
                      Showing the first {CHECK_ITEM_LIMIT} of {total.toLocaleString()}.
                    </p>
                  )}
                  <ul className={styles.list} aria-label="Issues">
                    {list.map((issue) => (
                      <IssueRow
                        key={issue.key}
                        issue={issue}
                        dismissed={id === 'dismissed'}
                        onToggle={(i) => toggle(i, id !== 'dismissed')}
                      />
                    ))}
                  </ul>
                </>
              )}
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
