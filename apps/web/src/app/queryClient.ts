import { QueryClient } from '@tanstack/react-query';

/** One client for the app; route loaders prefetch into it. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false } },
});
