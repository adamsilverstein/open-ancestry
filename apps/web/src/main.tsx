import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import './design/global.css';
import { syncTreesAcrossTabs } from './api/edits';
import { queryClient } from './app/queryClient';
import { router } from './app/router';
import { applyCspNonce } from './lib/cspNonce';

// Before any component can inject a <style> element.
applyCspNonce();
syncTreesAcrossTabs(queryClient);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
