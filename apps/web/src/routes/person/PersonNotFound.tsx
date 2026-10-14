import { Link, type NotFoundRouteProps } from '@tanstack/react-router';
import { UserRoundX } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState/EmptyState';
import styles from '../Page.module.css';

export function PersonNotFound({ data }: NotFoundRouteProps) {
  const noTree = (data as { reason?: string } | undefined)?.reason === 'no-tree';
  return (
    <div className={styles.centered}>
      <EmptyState
        level={1}
        icon={<UserRoundX size={28} aria-hidden />}
        title={noTree ? 'No tree open' : 'Person not found'}
        description={
          noTree
            ? 'Import a GEDCOM file to start a tree.'
            : 'This person is not in the open tree. They may have been deleted or merged.'
        }
        action={
          <Link to="/" className={styles.link}>
            Go home
          </Link>
        }
      />
    </div>
  );
}
