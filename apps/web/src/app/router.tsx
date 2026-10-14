import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';
import { AppShell } from './AppShell';
import { HomePage } from '../routes/HomePage';
import { NotFoundPage } from '../routes/NotFoundPage';

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: NotFoundPage,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
});

// Everything but the home page is split out of the initial bundle.
const designRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/design',
  component: lazyRouteComponent(() => import('../routes/DesignPage'), 'DesignPage'),
});

const treeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tree/$personId',
  component: lazyRouteComponent(() => import('../routes/TreePage'), 'TreePage'),
});

const personRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/person/$personId',
  component: lazyRouteComponent(() => import('../routes/PersonPage'), 'PersonPage'),
});

const routeTree = rootRoute.addChildren([homeRoute, designRoute, treeRoute, personRoute]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
