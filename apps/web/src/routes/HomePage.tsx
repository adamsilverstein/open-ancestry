import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, TreeDeciduous } from 'lucide-react';
import { Button } from '../components/Button/Button';
import { EmptyState } from '../components/EmptyState/EmptyState';
import { useToast } from '../components/Toast/Toast';
import { getTree, setCurrentTree, treesQuery } from '../library/api';
import { ImportDropZone } from './import/ImportDropZone';
import importStyles from './import/Import.module.css';
import styles from './Page.module.css';

const MAX_LISTED = 4;

/** First run: import a GEDCOM. With trees in the library, they are listed below to open. */
export function HomePage() {
  const { data: trees } = useQuery(treesQuery);
  // A short list keeps the page within one screen; the tree switcher lists every tree.
  const recent = [...(trees ?? [])]
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, MAX_LISTED);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  async function open(id: string) {
    try {
      await setCurrentTree(queryClient, id);
      const { homePersonId } = await getTree(id);
      if (homePersonId)
        await navigate({ to: '/tree/$personId', params: { personId: homePersonId } });
      else toast({ title: `“${id}” has no people yet` });
    } catch (error) {
      toast({ title: 'Could not open the tree', description: String(error), variant: 'error' });
    }
  }

  return (
    <div className={styles.home}>
      <EmptyState
        level={1}
        icon={<FileUp size={28} aria-hidden />}
        title="Import your Ancestry GEDCOM"
        description="Export your tree from Ancestry as a GEDCOM file, then import it here. Everything stays on this computer."
        action={
          <div className={styles.actions}>
            <ImportDropZone />
            <Link to="/design" className={styles.link}>
              Browse the design system
            </Link>
            {/* Last, since it arrives with the tree list: nothing below it moves (no layout shift). */}
            {recent.length > 0 && (
              <nav aria-label="Recent trees" className={importStyles.trees}>
                {recent.map((tree) => (
                  <Button
                    key={tree.id}
                    variant="ghost"
                    className={importStyles.treeButton}
                    iconStart={<TreeDeciduous size={16} aria-hidden />}
                    onClick={() => void open(tree.id)}
                  >
                    {tree.label}
                  </Button>
                ))}
              </nav>
            )}
          </div>
        }
      />
    </div>
  );
}
