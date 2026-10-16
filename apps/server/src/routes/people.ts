import { phoneticKeys } from '@open-ancestry/core';
import {
  LIVING_STATUSES,
  familyChildren,
  getNeighborhood,
  getPersonDetail,
  getPersonSummaries,
  getPersonSummary,
  getRelationship,
  listPeople,
  meta,
  searchPeople,
  suggestPlaces,
  type LivingStatus,
} from '@open-ancestry/db';
import type { Api, Deps } from '../context';
import { requireRow } from '../edits';
import { badRequest, notFound } from '../errors';
import {
  NeighborhoodQuery,
  PeopleQuery,
  RelationshipQuery,
  SearchQuery,
  PlacesQuery,
  TreeIdParams,
  TreeParams,
} from '../schemas';

function parseLiving(value: string | undefined): LivingStatus[] | undefined {
  if (value === undefined) return undefined;
  const list = value.split(',');
  const bad = list.find((s) => !(LIVING_STATUSES as readonly string[]).includes(s));
  if (bad) throw badRequest(`Unknown living status "${bad}"`);
  return list as LivingStatus[];
}

/**
 * Read endpoints: people list, person detail and summary, families,
 * neighborhood, relationship, search.
 */
export function peopleRoutes(app: Api, { library }: Deps): void {
  app.get(
    '/api/trees/:tree/people',
    { schema: { params: TreeParams, querystring: PeopleQuery } },
    async (request) => {
      const { sort, dir, sex, living, tag, limit, offset } = request.query;
      return listPeople(library.open(request.params.tree), {
        sort,
        direction: dir,
        sex,
        living: parseLiving(living),
        tagId: tag,
        limit: limit ?? 100,
        offset: offset ?? 0,
      });
    },
  );

  app.get('/api/trees/:tree/people/:id', { schema: { params: TreeIdParams } }, async (request) => {
    const detail = getPersonDetail(library.open(request.params.tree), request.params.id);
    if (!detail) throw notFound(`Person ${request.params.id} not found`);
    return detail;
  });

  app.get(
    '/api/trees/:tree/people/:id/summary',
    { schema: { params: TreeIdParams } },
    async (request) => {
      const summary = getPersonSummary(library.open(request.params.tree), request.params.id);
      if (!summary) throw notFound(`Person ${request.params.id} not found`);
      return summary;
    },
  );

  app.get(
    '/api/trees/:tree/families/:id',
    { schema: { params: TreeIdParams } },
    async (request) => {
      const store = library.open(request.params.tree);
      const family = requireRow(store, 'family', request.params.id);
      const links = familyChildren.listForFamily(store, family.id);
      const ids = [family.partner1_id, family.partner2_id, ...links.map((l) => l.child_id)].filter(
        (id): id is string => id !== null,
      );
      const people = new Map(getPersonSummaries(store, ids).map((s) => [s.id, s]));
      return {
        family,
        partner1: family.partner1_id ? (people.get(family.partner1_id) ?? null) : null,
        partner2: family.partner2_id ? (people.get(family.partner2_id) ?? null) : null,
        children: links.map((link) => ({ link, person: people.get(link.child_id) ?? null })),
        events: store
          .stmt(
            `SELECT e.*, pl.full_name AS place FROM event_role r JOIN event e ON e.id = r.event_id
           LEFT JOIN place pl ON pl.id = e.place_id
           WHERE r.family_id = ? ORDER BY e.date_sort IS NULL, e.date_sort, r.sort_order, e.id`,
          )
          .all(family.id),
      };
    },
  );

  app.get(
    '/api/trees/:tree/neighborhood',
    { schema: { params: TreeParams, querystring: NeighborhoodQuery } },
    async (request) => {
      const store = library.open(request.params.tree);
      const { focus, up, down, siblings, siblingsDepth } = request.query;
      const focusId = focus ?? meta.getHomePersonId(store);
      if (!focusId) throw badRequest('Give a focus person (no home person is set)');
      return getNeighborhood(store, focusId, { up, down, siblings, siblingsDepth });
    },
  );

  app.get(
    '/api/trees/:tree/relationship',
    { schema: { params: TreeParams, querystring: RelationshipQuery } },
    async (request) => {
      const store = library.open(request.params.tree);
      const { from } = request.query;
      const to = request.query.to ?? meta.getHomePersonId(store);
      if (!to) throw badRequest('Give a second person (no home person is set)');
      requireRow(store, 'person', from);
      requireRow(store, 'person', to);
      return getRelationship(store, from, to);
    },
  );

  app.get(
    '/api/trees/:tree/search',
    { schema: { params: TreeParams, querystring: SearchQuery } },
    async (request) => {
      const { q, limit = 20 } = request.query;
      return {
        items: searchPeople(library.open(request.params.tree), q, { limit, phoneticKeys }),
      };
    },
  );

  // Places whose full name contains the text, those starting with it first: the
  // event form suggests them so a typed place reuses the existing row (#280).
  app.get(
    '/api/trees/:tree/places',
    { schema: { params: TreeParams, querystring: PlacesQuery } },
    async (request) => {
      const { q, limit = 10 } = request.query;
      return { items: suggestPlaces(library.open(request.params.tree), q, limit) };
    },
  );
}
