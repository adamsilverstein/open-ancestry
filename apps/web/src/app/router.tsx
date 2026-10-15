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
import { validateMergeSearch } from '../routes/merge/search';
import { validatePersonSearch } from '../routes/person/search';
import { queryClient } from './queryClient';
import { AppShell } from './AppShell';
import { HomePage } from '../routes/HomePage';
import { NotFoundPage } from '../routes/NotFoundPage';
import { RouteErrorPage } from '../routes/RouteErrorPage';
import { validatePeopleSearch } from '../routes/people/search';
import { parseGenerations } from '../tree/api';

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
const treeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tree/$personId',
  // Shareable view state: which tree, which layout, how many generations.
  // Every key is set, undefined when invalid: TanStack Router merges this over
  // the raw search, so an unset key would let `?layout=bogus` through.
  validateSearch: (search: Record<string, unknown>): TreeSearch => ({
    tree: typeof search.tree === 'string' && search.tree ? search.tree : undefined,
    layout: treeLayouts.includes(search.layout as TreeLayoutKind)
      ? (search.layout as TreeLayoutKind)
      : undefined,
    up: parseGenerations(search.up),
    down: parseGenerations(search.down),
  }),
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

const peopleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/people',
  validateSearch: validatePeopleSearch,
  component: lazyRouteComponent(() => import('../routes/people/PeoplePage'), 'PeoplePage'),
});

const checkerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/checker',
  component: lazyRouteComponent(() => import('../routes/checker/CheckerPage'), 'CheckerPage'),
});

const mergeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/merge',
  validateSearch: validateMergeSearch,
  component: lazyRouteComponent(() => import('../routes/merge/MergePage'), 'MergePage'),
});

const importRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/import/$jobId',
  component: lazyRouteComponent(() => import('../routes/import/ImportPage'), 'ImportPage'),
});

const reimportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reimport/$jobId',
  component: lazyRouteComponent(() => import('../routes/reimport/ReimportPage'), 'ReimportPage'),
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  designRoute,
  treeRoute,
  personRoute,
  peopleRoute,
  importRoute,
  reimportRoute,
  checkerRoute,
  mergeRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  // Failed pages, including code that will not load after an update, render
  // inside the shell instead of replacing it.
  defaultErrorComponent: RouteErrorPage,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
