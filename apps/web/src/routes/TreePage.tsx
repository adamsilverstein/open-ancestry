import { useEffect, useId } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';
import { EmptyState } from '../components/EmptyState/EmptyState';
import { currentTreeQuery } from '../api/queries';
import { useUrlTree } from '../app/useUrlTree';
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
  useUrlTree(search.tree);

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
            description="Open someone's profile and choose More actions, then Set as home person, to open the tree there."
            action={
              <Link to="/people" className={styles.emptyLink}>
                Open the people list
              </Link>
            }
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
