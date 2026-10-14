import { phoneticKeys } from '@open-ancestry/core';
import {
  LIVING_STATUSES,
  familyChildren,
  getNeighborhood,
  getPersonDetail,
  getPersonSummaries,
  getPersonSummary,
  listPeople,
  meta,
  searchPeople,
  type LivingStatus,
} from '@open-ancestry/db';
import type { Api, Deps } from '../context';
import { requireRow } from '../edits';
import { badRequest, notFound } from '../errors';
import { NeighborhoodQuery, PeopleQuery, SearchQuery, TreeIdParams, TreeParams } from '../schemas';

function parseLiving(value: string | undefined): LivingStatus[] | undefined {
  if (value === undefined) return undefined;
  const list = value.split(',');
  const bad = list.find((s) => !(LIVING_STATUSES as readonly string[]).includes(s));
  if (bad) throw badRequest(`Unknown living status "${bad}"`);
  return list as LivingStatus[];
}

/** Read endpoints: people list, person detail and summary, families, neighborhood, search. */
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
      const { focus, up, down, siblings } = request.query;
      const focusId = focus ?? meta.getHomePersonId(store);
      if (!focusId) throw badRequest('Give a focus person (no home person is set)');
      return getNeighborhood(store, focusId, { up, down, siblings });
    },
  );

  app.get(
    '/api/trees/:tree/search',
    { schema: { params: TreeParams, querystring: SearchQuery } },
    async (request) => {
      const { q, limit = 20 } = request.query;
      const words = q.match(/[\p{L}\p{N}]+/gu) ?? [];
      // Treat the last word as the surname for sounds-like matches.
      const last = words.at(-1);
      const keys = last && words.length > 0 && /\p{L}{2,}/u.test(last) ? phoneticKeys(last) : [];
      return {
        items: searchPeople(library.open(request.params.tree), q, { limit, phoneticKeys: keys }),
      };
    },
  );
}
