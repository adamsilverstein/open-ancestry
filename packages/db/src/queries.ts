import type { ChildRelationship, LivingStatus, Privacy, RelationshipType, Sex } from './enums';
import { NotFoundError, type TreeStore } from './store';
import type {
  CitationLinkRow,
  CitationRow,
  EventRoleRow,
  EventRow,
  FamilyChildRow,
  FamilyRow,
  MediaLinkRow,
  MediaRow,
  NoteRow,
  PersonNameRow,
  PersonRow,
  PlaceRow,
  SourceRow,
  TagRow,
} from './types';

/*
 * Read models for the server. Summaries and graph slices are camelCase DTOs
 * (they go straight to the web app); detail views embed raw rows.
 */

const IDS = 'SELECT value FROM json_each(?)';

/** GEDCOM event types used for the birth / death line, best first. */
export const BIRTH_TYPES = ['BIRT', 'CHR', 'BAPM'] as const;
export const DEATH_TYPES = ['DEAT', 'BURI', 'CREM'] as const;

export interface EventBrief {
  eventId: string;
  type: string;
  dateText: string | null;
  dateQualifier: string | null;
  dateSort: number | null;
  place: string | null;
}

export interface PersonSummary {
  id: string;
  sex: Sex;
  living: LivingStatus;
  privacy: Privacy;
  primaryMediaId: string | null;
  given: string | null;
  surname: string | null;
  surnamePrefix: string | null;
  prefix: string | null;
  suffix: string | null;
  nickname: string | null;
  birth: EventBrief | null;
  death: EventBrief | null;
}

interface SummaryRow {
  id: string;
  sex: Sex;
  living: LivingStatus;
  privacy: Privacy;
  primary_media_id: string | null;
  given: string | null;
  surname: string | null;
  surname_prefix: string | null;
  prefix: string | null;
  suffix: string | null;
  nickname: string | null;
}

interface VitalRow {
  person_id: string;
  event_id: string;
  type: string;
  date_text: string | null;
  date_qualifier: string | null;
  date_sort: number | null;
  place: string | null;
  is_preferred: number;
  sort_order: number;
}

const VITAL_TYPES = [...BIRTH_TYPES, ...DEATH_TYPES].map((t) => `'${t}'`).join(', ');

/**
 * Summaries for many people in two queries, returned in request order (unknown
 * ids skipped). CROSS JOIN pins the join order so SQLite drives from the id list
 * instead of scanning every event of a vital type.
 */
export function getPersonSummaries(store: TreeStore, ids: readonly string[]): PersonSummary[] {
  if (ids.length === 0) return [];
  const json = JSON.stringify(ids);
  const rows = store
    .stmt(
      `SELECT p.id, p.sex, p.living, p.privacy, p.primary_media_id,
              n.given, n.surname, n.surname_prefix, n.prefix, n.suffix, n.nickname
       FROM person p LEFT JOIN person_name n ON n.person_id = p.id AND n.is_primary = 1
       WHERE p.id IN (${IDS})`,
    )
    .all(json) as SummaryRow[];
  const vitals = store
    .stmt(
      `SELECT r.person_id, e.id AS event_id, e.type, e.date_text, e.date_qualifier, e.date_sort,
              pl.full_name AS place, r.is_preferred, r.sort_order
       FROM json_each(?) j
       CROSS JOIN event_role r ON r.person_id = j.value AND r.role = 'principal'
       CROSS JOIN event e ON e.id = r.event_id AND e.type IN (${VITAL_TYPES})
       LEFT JOIN place pl ON pl.id = e.place_id`,
    )
    .all(json) as VitalRow[];

  const byPerson = new Map<string, VitalRow[]>();
  for (const v of vitals) {
    const list = byPerson.get(v.person_id);
    if (list) list.push(v);
    else byPerson.set(v.person_id, [v]);
  }
  const summaries = new Map<string, PersonSummary>();
  for (const r of rows) {
    const mine = byPerson.get(r.id) ?? [];
    summaries.set(r.id, {
      id: r.id,
      sex: r.sex,
      living: r.living,
      privacy: r.privacy,
      primaryMediaId: r.primary_media_id,
      given: r.given,
      surname: r.surname,
      surnamePrefix: r.surname_prefix,
      prefix: r.prefix,
      suffix: r.suffix,
      nickname: r.nickname,
      birth: pickVital(mine, BIRTH_TYPES),
      death: pickVital(mine, DEATH_TYPES),
    });
  }
  return ids.flatMap((id) => summaries.get(id) ?? []);
}

function pickVital(rows: VitalRow[], types: readonly string[]): EventBrief | null {
  let best: VitalRow | undefined;
  let bestRank = Infinity;
  for (const r of rows) {
    const typeRank = types.indexOf(r.type);
    if (typeRank < 0) continue;
    // Type priority first, then preferred alternates, then role order.
    const rank = typeRank * 1e6 + (r.is_preferred ? 0 : 5e5) + r.sort_order;
    if (rank < bestRank || (rank === bestRank && best && r.event_id < best.event_id)) {
      best = r;
      bestRank = rank;
    }
  }
  return best
    ? {
        eventId: best.event_id,
        type: best.type,
        dateText: best.date_text,
        dateQualifier: best.date_qualifier,
        dateSort: best.date_sort,
        place: best.place,
      }
    : null;
}

export function getPersonSummary(store: TreeStore, id: string): PersonSummary | null {
  return getPersonSummaries(store, [id])[0] ?? null;
}

// ---------------------------------------------------------------- detail

export interface CitationDetail {
  link: CitationLinkRow;
  citation: CitationRow;
  source: SourceRow;
}

export interface EventDetail {
  event: EventRow;
  role: EventRoleRow;
  place: PlaceRow | null;
  citations: CitationDetail[];
  notes: NoteRow[];
}

export interface RelativeLink {
  person: PersonSummary;
  link: FamilyChildRow;
}

export interface ParentFamily {
  family: FamilyRow;
  /** How this person is a child of the family. */
  link: FamilyChildRow;
  partner1: PersonSummary | null;
  partner2: PersonSummary | null;
  siblings: RelativeLink[];
}

export interface PartnerFamily {
  family: FamilyRow;
  partner: PersonSummary | null;
  children: RelativeLink[];
  events: EventDetail[];
}

export interface PersonDetail {
  person: PersonRow;
  summary: PersonSummary;
  names: PersonNameRow[];
  /** Events the person has a role in, by date (undated last). */
  events: EventDetail[];
  /** Citations attached to the person record itself. */
  citations: CitationDetail[];
  parentFamilies: ParentFamily[];
  partnerFamilies: PartnerFamily[];
  media: { media: MediaRow; link: MediaLinkRow }[];
  notes: NoteRow[];
  tags: TagRow[];
}

function rows<R>(store: TreeStore, sql: string, ...params: unknown[]): R[] {
  return store.stmt(sql).all(...params) as R[];
}

/** Events with places, citations and notes for a set of roles. */
function eventDetails(store: TreeStore, roles: EventRoleRow[]): EventDetail[] {
  if (roles.length === 0) return [];
  const eventIds = JSON.stringify(roles.map((r) => r.event_id));
  const eventsById = new Map(
    rows<EventRow>(store, `SELECT * FROM event WHERE id IN (${IDS})`, eventIds).map((e) => [
      e.id,
      e,
    ]),
  );
  const placeIds = JSON.stringify([...eventsById.values()].map((e) => e.place_id).filter(Boolean));
  const placesById = new Map(
    rows<PlaceRow>(store, `SELECT * FROM place WHERE id IN (${IDS})`, placeIds).map((p) => [
      p.id,
      p,
    ]),
  );
  const citations = citationDetails(store, 'event', eventIds);
  const notes = noteDetails(store, 'event', eventIds);
  return roles
    .map((role) => {
      const event = eventsById.get(role.event_id) as EventRow;
      return {
        event,
        role,
        place: event.place_id ? (placesById.get(event.place_id) ?? null) : null,
        citations: citations.get(event.id) ?? [],
        notes: notes.get(event.id) ?? [],
      };
    })
    .sort(
      (a, b) =>
        (a.event.date_sort ?? Infinity) - (b.event.date_sort ?? Infinity) ||
        a.role.sort_order - b.role.sort_order ||
        (a.event.id < b.event.id ? -1 : 1),
    );
}

function byId<R extends { id: string }>(list: R[]): Map<string, R> {
  return new Map(list.map((r) => [r.id, r]));
}

function groupBy<R>(list: R[], key: (r: R) => string): Map<string, R[]> {
  const groups = new Map<string, R[]>();
  for (const r of list) {
    const k = key(r);
    const group = groups.get(k);
    if (group) group.push(r);
    else groups.set(k, [r]);
  }
  return groups;
}

function citationDetails(store: TreeStore, ownerType: string, ownerIdsJson: string) {
  const links = rows<CitationLinkRow>(
    store,
    `SELECT * FROM citation_link WHERE owner_type = ? AND owner_id IN (${IDS}) ORDER BY sort_order, id`,
    ownerType,
    ownerIdsJson,
  );
  if (links.length === 0) return new Map<string, CitationDetail[]>();
  const citations = byId(
    rows<CitationRow>(
      store,
      `SELECT * FROM citation WHERE id IN (${IDS})`,
      JSON.stringify(links.map((l) => l.citation_id)),
    ),
  );
  const sources = byId(
    rows<SourceRow>(
      store,
      `SELECT * FROM source WHERE id IN (${IDS})`,
      JSON.stringify([...citations.values()].map((c) => c.source_id)),
    ),
  );
  const details = links.map((link) => {
    const citation = citations.get(link.citation_id) as CitationRow;
    return { link, citation, source: sources.get(citation.source_id) as SourceRow };
  });
  return groupBy(details, (d) => d.link.owner_id);
}

function noteDetails(store: TreeStore, ownerType: string, ownerIdsJson: string) {
  const found = rows<NoteRow & { owner_id: string }>(
    store,
    `SELECT n.*, l.owner_id FROM note_link l JOIN note n ON n.id = l.note_id
     WHERE l.owner_type = ? AND l.owner_id IN (${IDS}) ORDER BY l.sort_order, l.id`,
    ownerType,
    ownerIdsJson,
  );
  return new Map(
    [...groupBy(found, (n) => n.owner_id)].map(([owner, list]) => [
      owner,
      list.map(({ owner_id: _owner, ...note }) => note as NoteRow),
    ]),
  );
}

/** Everything the person page needs, in a handful of indexed queries. */
export function getPersonDetail(store: TreeStore, id: string): PersonDetail | null {
  const person = store.getRow('person', id);
  if (!person) return null;
  const idJson = JSON.stringify([id]);

  const names = rows<PersonNameRow>(
    store,
    'SELECT * FROM person_name WHERE person_id = ? ORDER BY is_primary DESC, sort_order, id',
    id,
  );
  const roles = rows<EventRoleRow>(store, 'SELECT * FROM event_role WHERE person_id = ?', id);

  const childLinks = rows<FamilyChildRow>(
    store,
    'SELECT * FROM family_child WHERE child_id = ? ORDER BY id',
    id,
  );
  const parentFams = rows<FamilyRow>(
    store,
    `SELECT f.* FROM family_child fc JOIN family f ON f.id = fc.family_id WHERE fc.child_id = ? ORDER BY fc.id`,
    id,
  );
  const partnerFams = rows<FamilyRow>(
    store,
    `SELECT * FROM family WHERE partner1_id = @id OR partner2_id = @id
     ORDER BY CASE WHEN partner1_id = @id THEN partner1_order ELSE partner2_order END, id`,
    { id },
  );
  const familyIds = JSON.stringify([...parentFams, ...partnerFams].map((f) => f.id));
  const kin = rows<FamilyChildRow>(
    store,
    `SELECT * FROM family_child WHERE family_id IN (${IDS}) ORDER BY family_id, sort_order, id`,
    familyIds,
  );
  const familyRoles = rows<EventRoleRow>(
    store,
    `SELECT * FROM event_role WHERE family_id IN (${IDS})`,
    JSON.stringify(partnerFams.map((f) => f.id)),
  );

  const relatedIds = new Set<string>([id]);
  for (const f of [...parentFams, ...partnerFams]) {
    if (f.partner1_id) relatedIds.add(f.partner1_id);
    if (f.partner2_id) relatedIds.add(f.partner2_id);
  }
  for (const k of kin) relatedIds.add(k.child_id);
  const summaries = new Map(getPersonSummaries(store, [...relatedIds]).map((s) => [s.id, s]));
  const summary = (pid: string | null) => (pid ? (summaries.get(pid) ?? null) : null);
  const relatives = (familyId: string, exclude: string | null) =>
    kin
      .filter((k) => k.family_id === familyId && k.child_id !== exclude)
      .map((link) => ({ person: summaries.get(link.child_id) as PersonSummary, link }));

  const familyEvents = eventDetails(store, familyRoles);

  return {
    person,
    summary: summaries.get(id) as PersonSummary,
    names,
    events: eventDetails(store, roles),
    citations: citationDetails(store, 'person', idJson).get(id) ?? [],
    parentFamilies: parentFams.map((family) => ({
      family,
      link: childLinks.find((l) => l.family_id === family.id) as FamilyChildRow,
      partner1: summary(family.partner1_id),
      partner2: summary(family.partner2_id),
      siblings: relatives(family.id, id),
    })),
    partnerFamilies: partnerFams.map((family) => ({
      family,
      partner: summary(family.partner1_id === id ? family.partner2_id : family.partner1_id),
      children: relatives(family.id, null),
      events: familyEvents.filter((e) => e.role.family_id === family.id),
    })),
    media: mediaFor(store, id),
    notes: noteDetails(store, 'person', idJson).get(id) ?? [],
    tags: rows<TagRow>(
      store,
      `SELECT t.* FROM tag_link l JOIN tag t ON t.id = l.tag_id
       WHERE l.owner_type = 'person' AND l.owner_id = ? ORDER BY t.category, t.name`,
      id,
    ),
  };
}

function mediaFor(store: TreeStore, personId: string) {
  const links = rows<MediaLinkRow>(
    store,
    "SELECT * FROM media_link WHERE owner_type = 'person' AND owner_id = ? ORDER BY sort_order, id",
    personId,
  );
  const items = byId(
    rows<MediaRow>(
      store,
      `SELECT * FROM media WHERE id IN (${IDS})`,
      JSON.stringify(links.map((l) => l.media_id)),
    ),
  );
  return links.map((link) => ({ media: items.get(link.media_id) as MediaRow, link }));
}

// ---------------------------------------------------------------- neighborhood

export interface FamilyEdge {
  id: string;
  partner1Id: string | null;
  partner2Id: string | null;
  relationshipType: RelationshipType;
  partner1Order: number;
  partner2Order: number;
}

export interface ChildEdge {
  familyId: string;
  childId: string;
  partner1Rel: ChildRelationship;
  partner2Rel: ChildRelationship;
  sortOrder: number;
}

export interface Neighborhood {
  focusId: string;
  /** Focus first, then breadth-first; each person once even with pedigree collapse. */
  people: PersonSummary[];
  /** Partner edges. */
  families: FamilyEdge[];
  /** Parent-child edges (child to family). */
  children: ChildEdge[];
  /** People at the top edge who have parents not included. */
  moreUp: string[];
  /** People at the bottom edge who have children not included. */
  moreDown: string[];
}

export interface NeighborhoodOptions {
  /** Generations of ancestors (default 4). */
  up?: number;
  /** Generations of descendants (default 3). */
  down?: number;
  /** Include the focus person's siblings (default true). */
  siblings?: boolean;
}

/**
 * A compact graph slice around a person for the tree views: ancestors `up`
 * generations, descendants `down` generations with their partners, and the
 * focus person's siblings. One batched query per generation and direction.
 */
export function getNeighborhood(
  store: TreeStore,
  focusId: string,
  { up = 4, down = 3, siblings = true }: NeighborhoodOptions = {},
): Neighborhood {
  if (!store.getRow('person', focusId)) throw new NotFoundError('person', focusId);
  const people = new Set<string>([focusId]);
  const families = new Map<string, FamilyEdge>();
  const children = new Map<string, ChildEdge>();

  const addFamily = (f: FamilyRow) => {
    if (families.has(f.id)) return;
    families.set(f.id, {
      id: f.id,
      partner1Id: f.partner1_id,
      partner2Id: f.partner2_id,
      relationshipType: f.relationship_type,
      partner1Order: f.partner1_order,
      partner2Order: f.partner2_order,
    });
  };
  const addChild = (c: FamilyChildRow) => {
    children.set(c.id, {
      familyId: c.family_id,
      childId: c.child_id,
      partner1Rel: c.partner1_rel,
      partner2Rel: c.partner2_rel,
      sortOrder: c.sort_order,
    });
    people.add(c.child_id);
  };
  type ParentRow = FamilyRow & {
    link_id: string;
    child_id: string;
    partner1_rel: ChildRelationship;
    partner2_rel: ChildRelationship;
    sort_order: number;
  };
  const parentFamilies = (ids: string[]) =>
    rows<ParentRow>(
      store,
      `SELECT f.*, fc.id AS link_id, fc.child_id, fc.partner1_rel, fc.partner2_rel, fc.sort_order
       FROM family_child fc JOIN family f ON f.id = fc.family_id
       WHERE fc.child_id IN (${IDS}) ORDER BY fc.child_id, fc.id`,
      JSON.stringify(ids),
    );
  const partnerFamilies = (ids: string[]) =>
    rows<FamilyRow>(
      store,
      `SELECT * FROM family WHERE partner1_id IN (${IDS})
       UNION SELECT * FROM family WHERE partner2_id IN (${IDS}) ORDER BY id`,
      JSON.stringify(ids),
      JSON.stringify(ids),
    );
  const childrenOf = (familyIds: string[]) =>
    rows<FamilyChildRow>(
      store,
      `SELECT * FROM family_child WHERE family_id IN (${IDS}) ORDER BY family_id, sort_order, id`,
      JSON.stringify(familyIds),
    );

  // Ancestors.
  let frontier = [focusId];
  const seenUp = new Set(frontier);
  for (let generation = 0; generation < up && frontier.length > 0; generation++) {
    const next: string[] = [];
    const found = parentFamilies(frontier);
    for (const f of found) {
      addFamily(f);
      addChild({ ...f, id: f.link_id, family_id: f.id });
      for (const parent of [f.partner1_id, f.partner2_id]) {
        if (parent && !seenUp.has(parent)) {
          seenUp.add(parent);
          people.add(parent);
          next.push(parent);
        }
      }
    }
    if (generation === 0 && siblings && found.length > 0) {
      for (const c of childrenOf(found.map((f) => f.id))) addChild(c);
    }
    frontier = next;
  }
  const moreUp =
    frontier.length === 0
      ? []
      : rows<{ child_id: string }>(
          store,
          `SELECT DISTINCT child_id FROM family_child WHERE child_id IN (${IDS}) ORDER BY child_id`,
          JSON.stringify(frontier),
        ).map((r) => r.child_id);

  // Descendants, with each generation's partners.
  frontier = [focusId];
  const seenDown = new Set(frontier);
  let moreDown: string[] = [];
  for (let generation = 0; frontier.length > 0; generation++) {
    const fams = partnerFamilies(frontier);
    for (const f of fams) {
      addFamily(f);
      if (f.partner1_id) people.add(f.partner1_id);
      if (f.partner2_id) people.add(f.partner2_id);
    }
    const kids = fams.length > 0 ? childrenOf(fams.map((f) => f.id)) : [];
    if (generation === down) {
      const frontierSet = new Set(frontier);
      const withKids = new Set(kids.map((k) => k.family_id));
      moreDown = [
        ...new Set(
          fams
            .filter((f) => withKids.has(f.id))
            .flatMap((f) => [f.partner1_id, f.partner2_id])
            .filter((p): p is string => p !== null && frontierSet.has(p)),
        ),
      ].sort();
      break;
    }
    const next: string[] = [];
    for (const k of kids) {
      addChild(k);
      if (!seenDown.has(k.child_id)) {
        seenDown.add(k.child_id);
        next.push(k.child_id);
      }
    }
    frontier = next;
  }

  return {
    focusId,
    people: getPersonSummaries(store, [...people]),
    families: [...families.values()],
    children: [...children.values()],
    moreUp,
    moreDown,
  };
}

// ---------------------------------------------------------------- list

export type PeopleSort = 'surname' | 'given' | 'birth' | 'death';

export interface ListPeopleOptions {
  sort?: PeopleSort;
  direction?: 'asc' | 'desc';
  sex?: Sex;
  living?: LivingStatus[];
  tagId?: string;
  limit?: number;
  offset?: number;
}

const vitalSort = (types: readonly string[]) =>
  `(SELECT min(e.date_sort) FROM event_role r CROSS JOIN event e ON e.id = r.event_id
    WHERE r.person_id = p.id AND r.role = 'principal' AND e.type IN (${types.map((t) => `'${t}'`).join(', ')}))`;

/** The people list: sorted, filtered and paginated, with the total match count. */
export function listPeople(
  store: TreeStore,
  {
    sort = 'surname',
    direction = 'asc',
    sex,
    living,
    tagId,
    limit = 100,
    offset = 0,
  }: ListPeopleOptions = {},
): { total: number; items: PersonSummary[] } {
  const dir = direction === 'desc' ? 'DESC' : 'ASC';
  const where: string[] = [];
  const params: unknown[] = [];
  if (sex) {
    where.push('p.sex = ?');
    params.push(sex);
  }
  if (living) {
    where.push(`p.living IN (${IDS})`);
    params.push(JSON.stringify(living));
  }
  if (tagId) {
    where.push(
      "EXISTS (SELECT 1 FROM tag_link t WHERE t.tag_id = ? AND t.owner_type = 'person' AND t.owner_id = p.id)",
    );
    params.push(tagId);
  }
  const key = {
    surname: `n.surname IS NULL, n.surname COLLATE NOCASE ${dir}, n.given COLLATE NOCASE ${dir}`,
    given: `n.given IS NULL, n.given COLLATE NOCASE ${dir}, n.surname COLLATE NOCASE ${dir}`,
    birth: `k IS NULL, k ${dir}`,
    death: `k IS NULL, k ${dir}`,
  }[sort];
  const sortExpr =
    sort === 'birth' ? vitalSort(BIRTH_TYPES) : sort === 'death' ? vitalSort(DEATH_TYPES) : 'NULL';
  const from = `FROM person p LEFT JOIN person_name n ON n.person_id = p.id AND n.is_primary = 1
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const total = (store.stmt(`SELECT count(*) AS n ${from}`).get(...params) as { n: number }).n;
  const ids = (
    store
      .stmt(`SELECT p.id, ${sortExpr} AS k ${from} ORDER BY ${key}, p.id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as { id: string }[]
  ).map((r) => r.id);
  return { total, items: getPersonSummaries(store, ids) };
}
