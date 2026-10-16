import { QueryClient } from '@tanstack/react-query';

/** One client for the app; route loaders prefetch into it. */
export const queryClient = new QueryClient({
  defaultOptions: {
    // The API is on this computer: being offline (wifi off) must never pause
    // reads or saves, which would also hold up every queued edit and undo.
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: false,
      networkMode: 'always',
    },
    mutations: { networkMode: 'always' },
  },
});
