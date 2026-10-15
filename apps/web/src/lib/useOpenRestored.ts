import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';

/** Opens a person an undo just brought back; pass to `undoRedo` as `onRestored`. */
export function useOpenRestored(): (personId: string) => Promise<void> {
  const navigate = useNavigate();
  return useCallback(
    (personId: string) => navigate({ to: '/person/$personId', params: { personId } }),
    [navigate],
  );
}
