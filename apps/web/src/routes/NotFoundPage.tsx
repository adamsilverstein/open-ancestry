import { Link } from '@tanstack/react-router';
import { MapPinOff } from 'lucide-react';
import { EmptyState } from '../components/EmptyState/EmptyState';
import styles from './Page.module.css';

export function NotFoundPage() {
  return (
    <div className={styles.centered}>
      <EmptyState
        level={1}
        icon={<MapPinOff size={28} aria-hidden />}
        title="Page not found"
        description="That page does not exist. It may have moved, or the link is incomplete."
        action={
          <Link to="/" className={styles.link}>
            Go home
          </Link>
        }
      />
    </div>
  );
}
