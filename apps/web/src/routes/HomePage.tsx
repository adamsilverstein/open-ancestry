import { Link } from '@tanstack/react-router';
import { FileUp } from 'lucide-react';
import { Button } from '../components/Button/Button';
import { EmptyState } from '../components/EmptyState/EmptyState';
import { useToast } from '../components/Toast/Toast';
import styles from './Page.module.css';

export function HomePage() {
  const toast = useToast();
  return (
    <div className={styles.centered}>
      <EmptyState
        level={1}
        icon={<FileUp size={28} aria-hidden />}
        title="Import your Ancestry GEDCOM"
        description="Export your tree from Ancestry as a GEDCOM file, then import it here. Everything stays on this computer."
        action={
          <div className={styles.actions}>
            <Button
              variant="primary"
              iconStart={<FileUp size={16} aria-hidden />}
              onClick={() => toast({ title: 'Import is coming soon' })}
            >
              Import GEDCOM
            </Button>
            <Link to="/design" className={styles.link}>
              Browse the design system
            </Link>
          </div>
        }
      />
    </div>
  );
}
