import { useRef } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, FolderOpen, Users } from 'lucide-react';
import { currentTreeQuery } from '../../api/queries';
import {
  PEOPLE_PAGE_SIZE,
  peoplePageQuery,
  tagsQuery,
  type PeopleParams,
  type PeopleSort,
} from '../../api/search';
import type { ApiPersonSummary } from '../../api/types';
import { Avatar } from '../../components/Avatar/Avatar';
import { Button } from '../../components/Button/Button';
import { EmptyState } from '../../components/EmptyState/EmptyState';
import { Select } from '../../components/Select/Select';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { fullName, toPersonSummary } from '../../lib/person';
import { toPeopleParams, type PeopleSearch } from './search';
import styles from './PeoplePage.module.css';

const route = getRouteApi('/people');

const ROW_HEIGHT = 44;
const ANY = 'any';

const COLUMNS: { key: string; label: string; sort?: PeopleSort }[] = [
  { key: 'given', label: 'Given names', sort: 'given' },
  { key: 'surname', label: 'Surname', sort: 'surname' },
  { key: 'birth', label: 'Birth', sort: 'birth' },
  { key: 'death', label: 'Death', sort: 'death' },
  { key: 'place', label: 'Birthplace' },
];

const countLabel = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}`;

/** Everyone in the open tree: sortable, filterable, and virtualized for 100k rows. */
export function PeoplePage() {
  const { data: tree, isPending } = useQuery(currentTreeQuery);
  return (
    <div className={styles.page}>
      {isPending ? (
        <>
          <h1 className={styles.title}>People</h1>
          <Skeleton height={ROW_HEIGHT * 6} />
        </>
      ) : tree ? (
        <PeopleTable tree={tree} />
      ) : (
        <>
          <h1 className={styles.title}>People</h1>
          <EmptyState
            icon={<FolderOpen size={28} aria-hidden />}
            title="No tree is open"
            description="Import a GEDCOM to see everyone in your tree here."
            action={<Link to="/">Go to the start page</Link>}
          />
        </>
      )}
    </div>
  );
}

function PeopleTable({ tree }: { tree: string }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const params = toPeopleParams(search);
  const scroller = useRef<HTMLDivElement>(null);

  const first = useQuery(peoplePageQuery(tree, params, 0));
  const total = first.data?.total ?? 0;
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualizer re-renders us itself.
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const rows = virtualizer.getVirtualItems();
  const pages = [...new Set(rows.map((r) => Math.floor(r.index / PEOPLE_PAGE_SIZE)))];
  const loaded = useQueries({ queries: pages.map((page) => peoplePageQuery(tree, params, page)) });
  const byPage = new Map(pages.map((page, i) => [page, loaded[i]?.data?.items]));
  const personAt = (index: number): ApiPersonSummary | undefined =>
    byPage.get(Math.floor(index / PEOPLE_PAGE_SIZE))?.[index % PEOPLE_PAGE_SIZE];

  const update = (next: PeopleSearch) =>
    void navigate({ search: next, replace: true }).then(() => {
      scroller.current?.scrollTo({ top: 0 });
    });
  const filtered = Boolean(search.sex || search.living || search.tag);

  return (
    <>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>People</h1>
          <span className={styles.count} data-testid="people-count" aria-live="polite">
            {first.data ? countLabel(total) : ''}
          </span>
        </div>
        <Filters tree={tree} search={search} onChange={update} />
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update({ sort: search.sort, dir: search.dir })}
          >
            Clear filters
          </Button>
        )}
        <span className={styles.toolLinks}>
          <Link to="/tags">Manage tags</Link>
          <Link to="/checker">Check tree</Link>
        </span>
      </header>

      <div
        hidden={first.data !== undefined && total === 0}
        role="table"
        aria-label="People"
        aria-rowcount={total + 1}
        aria-busy={first.isPending || undefined}
        className={styles.table}
      >
        <div ref={scroller} className={styles.scroller} data-testid="people-scroller">
          <div role="rowgroup" className={styles.head}>
            <div role="row" aria-rowindex={1} className={styles.row}>
              {COLUMNS.map((column) => (
                <HeaderCell
                  key={column.key}
                  label={column.label}
                  sort={column.sort}
                  params={params}
                  onSort={(sort) =>
                    update({
                      ...search,
                      sort: sort === 'surname' ? undefined : sort,
                      dir: sort === params.sort && params.dir === 'asc' ? 'desc' : undefined,
                    })
                  }
                />
              ))}
            </div>
          </div>
          <div role="rowgroup" className={styles.body} style={{ height: total * ROW_HEIGHT }}>
            {rows.map((row) => (
              <PersonRow
                key={row.key}
                index={row.index}
                top={row.start}
                person={personAt(row.index)}
              />
            ))}
          </div>
        </div>
      </div>
      {first.data && total === 0 && (
        <EmptyState
          icon={<Users size={28} aria-hidden />}
          title={filtered ? 'No people match these filters' : 'No people in this tree yet'}
        />
      )}
    </>
  );
}

function HeaderCell({
  label,
  sort,
  params,
  onSort,
}: {
  label: string;
  sort: PeopleSort | undefined;
  params: PeopleParams;
  onSort: (sort: PeopleSort) => void;
}) {
  const active = sort !== undefined && params.sort === sort;
  const ariaSort = active ? (params.dir === 'asc' ? 'ascending' : 'descending') : undefined;
  const Icon = !active ? ArrowUpDown : params.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <div role="columnheader" aria-sort={ariaSort} className={styles.cell}>
      {sort ? (
        <button type="button" className={styles.sortButton} onClick={() => onSort(sort)}>
          {label}
          <Icon size={14} aria-hidden className={active ? undefined : styles.sortIdle} />
        </button>
      ) : (
        label
      )}
    </div>
  );
}

function PersonRow({
  index,
  top,
  person,
}: {
  index: number;
  top: number;
  person: ApiPersonSummary | undefined;
}) {
  const style = { transform: `translateY(${top}px)`, height: ROW_HEIGHT };
  if (!person) {
    return (
      <div role="row" aria-rowindex={index + 2} className={styles.row} style={style}>
        {COLUMNS.map((column) => (
          <div key={column.key} role="cell" className={styles.cell}>
            <Skeleton width="60%" height={12} />
          </div>
        ))}
      </div>
    );
  }
  const summary = toPersonSummary(person);
  return (
    <div role="row" aria-rowindex={index + 2} className={styles.row} style={style}>
      <div role="cell" className={styles.cell} data-column="given">
        <Avatar name={summary.name} sex={summary.sex} size={24} decorative />
        <Link
          to="/person/$personId"
          params={{ personId: person.id }}
          className={styles.name}
          aria-label={fullName(person)}
        >
          {person.given || 'Unknown'}
        </Link>
      </div>
      <div role="cell" className={styles.cell} data-column="surname">
        {person.surname}
      </div>
      <div role="cell" className={styles.cell} data-column="birth">
        {person.birth?.dateText}
      </div>
      <div role="cell" className={styles.cell} data-column="death">
        {person.death?.dateText}
      </div>
      <div role="cell" className={styles.cell} data-column="place">
        {person.birth?.place}
      </div>
    </div>
  );
}

function Filters({
  tree,
  search,
  onChange,
}: {
  tree: string;
  search: PeopleSearch;
  onChange: (next: PeopleSearch) => void;
}) {
  const { data: tags = [] } = useQuery(tagsQuery(tree));
  const set = <K extends keyof PeopleSearch>(key: K, value: string) =>
    onChange({ ...search, [key]: value === ANY ? undefined : value });
  return (
    <div className={styles.filters}>
      <Select
        label="Sex"
        value={search.sex ?? ANY}
        onValueChange={(v) => set('sex', v)}
        options={[
          { value: ANY, label: 'Any' },
          { value: 'F', label: 'Female' },
          { value: 'M', label: 'Male' },
          { value: 'X', label: 'Other' },
          { value: 'U', label: 'Unknown' },
        ]}
      />
      <Select
        label="Living"
        value={search.living ?? ANY}
        onValueChange={(v) => set('living', v)}
        options={[
          { value: ANY, label: 'Anyone' },
          { value: 'living', label: 'Living' },
          { value: 'deceased', label: 'Deceased' },
        ]}
      />
      <Select
        label="Tag"
        value={search.tag ?? ANY}
        onValueChange={(v) => set('tag', v)}
        options={[
          { value: ANY, label: 'Any tag' },
          ...tags.map((t) => ({
            value: t.id,
            label: t.category ? `${t.name} (${t.category})` : t.name,
          })),
        ]}
      />
    </div>
  );
}
