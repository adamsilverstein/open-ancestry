import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  notFound,
} from '@tanstack/react-router';
import { isNotFound } from '../api/client';
import { currentTreeQuery, personQuery } from '../api/queries';
import { PersonNotFound } from '../routes/person/PersonNotFound';
import { PersonSkeleton } from '../routes/person/PersonSkeleton';
import { validatePersonSearch } from '../routes/person/search';
import { queryClient } from './queryClient';
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

const treeLayouts = ['family', 'pedigree', 'descendants', 'fan'] as const;
type TreeLayoutKind = (typeof treeLayouts)[number];
interface TreeSearch {
  tree?: string;
  layout?: TreeLayoutKind;
  up?: number;
  down?: number;
}
const generations = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10
    ? value
    : undefined;

const treeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tree/$personId',
  // Shareable view state: which tree, which layout, how many generations.
  validateSearch: (search: Record<string, unknown>): TreeSearch => {
    const valid: TreeSearch = {};
    if (typeof search.tree === 'string' && search.tree) valid.tree = search.tree;
    if (treeLayouts.includes(search.layout as TreeLayoutKind)) {
      valid.layout = search.layout as TreeLayoutKind;
    }
    const up = generations(search.up);
    if (up !== undefined) valid.up = up;
    const down = generations(search.down);
    if (down !== undefined) valid.down = down;
    return valid;
  },
  component: lazyRouteComponent(() => import('../routes/TreePage'), 'TreePage'),
});

const personRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/person/$personId',
  validateSearch: validatePersonSearch,
  // Runs on hover/focus preload too, so the detail is usually cached by the click.
  loader: async ({ params }) => {
    const tree = await queryClient.ensureQueryData(currentTreeQuery);
    if (!tree) throw notFound({ data: { reason: 'no-tree' } });
    try {
      await queryClient.ensureQueryData(personQuery(tree, params.personId));
    } catch (error) {
      if (isNotFound(error)) throw notFound();
      throw error;
    }
    return { tree };
  },
  pendingComponent: PersonSkeleton,
  pendingMs: 150,
  pendingMinMs: 0,
  notFoundComponent: PersonNotFound,
  component: lazyRouteComponent(() => import('../routes/person/PersonPage'), 'PersonPage'),
});

const routeTree = rootRoute.addChildren([homeRoute, designRoute, treeRoute, personRoute]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
