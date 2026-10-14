import { useEffect, useId, useRef } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';
import { EmptyState } from '../components/EmptyState/EmptyState';
import { CURRENT_TREE_KEY, currentTreeQuery } from '../api/queries';
import { fetchHome, treeKeys } from '../tree/api';
import { TreeView } from '../tree/TreeView';
import styles from '../tree/TreeView.module.css';

/** `/tree/:personId?tree=`: the tree view. `home` as the person opens the home person. */
export function TreePage() {
  const headingId = useId();
  const navigate = useNavigate();
  const { personId } = useParams({ from: '/tree/$personId' });
  const search = useSearch({ from: '/tree/$personId' });
  // `?tree=` wins (shareable links); otherwise the app's current tree.
  const current = useQuery(currentTreeQuery);
  const tree = search.tree ?? current.data ?? undefined;
  const wantsHome = personId === 'home';
  const home = useQuery({
    queryKey: treeKeys.home(tree ?? ''),
    queryFn: ({ signal }) => fetchHome(tree!, signal),
    enabled: Boolean(tree) && wantsHome,
  });

  // A shared link opens its tree: make it the current one (top bar, next visit).
  const queryClient = useQueryClient();
  const synced = useRef<string | null>(null);
  useEffect(() => {
    if (!search.tree || synced.current === search.tree) return;
    synced.current = search.tree;
    try {
      localStorage.setItem(CURRENT_TREE_KEY, search.tree);
    } catch {
      // Storage may be unavailable; the URL still says which tree.
    }
    queryClient.setQueryData(currentTreeQuery.queryKey, search.tree);
  }, [search.tree, queryClient]);

  // Switching trees from the top bar (current tree moves away from the one on
  // screen) opens the new tree at its home person.
  const previousCurrent = useRef(current.data);
  useEffect(() => {
    const before = previousCurrent.current;
    previousCurrent.current = current.data;
    if (!search.tree || before !== search.tree) return;
    if (!current.data || current.data === search.tree) return;
    void navigate({ to: '/tree/$personId', params: { personId: 'home' }, search: {} });
  }, [current.data, search.tree, navigate]);

  useEffect(() => {
    if (!wantsHome || !home.data || !tree) return;
    void navigate({
      to: '/tree/$personId',
      params: { personId: home.data },
      search: { ...search, tree },
      replace: true,
    });
  }, [wantsHome, home.data, tree, search, navigate]);

  let body;
  if (!search.tree && current.data === null) {
    body = (
      <div className={styles.empty}>
        <div className={styles.emptyPanel} data-surface="raised">
          <EmptyState
            level={2}
            icon={<FileUp size={28} aria-hidden />}
            title="No trees yet"
            description="Import a GEDCOM file to see your family tree here."
            action={
              <Link to="/" className={styles.emptyLink}>
                Import a tree
              </Link>
            }
          />
        </div>
      </div>
    );
  } else if (wantsHome && home.isSuccess && !home.data) {
    body = (
      <div className={styles.empty}>
        <div className={styles.emptyPanel} data-surface="raised">
          <EmptyState
            level={2}
            title="No home person"
            description="Choose a home person from someone's profile to open the tree there."
          />
        </div>
      </div>
    );
  } else if (tree && !wantsHome) {
    body = <TreeView key={tree} tree={tree} personId={personId} search={search} />;
  }

  return (
    <section
      aria-labelledby={headingId}
      className={styles.page}
      data-surface="canvas"
      data-tree-region
    >
      <h1 id={headingId} className="oa-visually-hidden">
        Family tree
      </h1>
      {body}
    </section>
  );
}
