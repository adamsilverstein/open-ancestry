import {
  CHILD_RELATIONSHIPS,
  EVENT_ROLES,
  LIVING_STATUSES,
  NAME_TYPES,
  NOTE_OWNERS,
  PRIVACY_LEVELS,
  RELATIONSHIP_TYPES,
  SEXES,
} from '@open-ancestry/db';
import { Type, type Static, type TProperties } from 'typebox';

/*
 * Request schemas. Fastify validates every route's params, query and body
 * against these (unknown body properties are rejected), and TypeBox gives the
 * handlers matching types. Write bodies use the database column names.
 */

const strict = { additionalProperties: false } as const;
const text = (maxLength: number) => Type.String({ maxLength });
const nullableText = (maxLength: number) => Type.Union([text(maxLength), Type.Null()]);

export const Id = Type.String({ minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z_-]+$' });

export const TreeParams = Type.Object({ tree: Type.String({ minLength: 1, maxLength: 100 }) });
export const TreeIdParams = Type.Object({ tree: TreeParams.properties.tree, id: Id });
export const JobParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export const TreeBody = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 100 }) },
  strict,
);

export const Sex = Type.Enum(SEXES);
export const Living = Type.Enum(LIVING_STATUSES);
export const Privacy = Type.Enum(PRIVACY_LEVELS);
export const ChildRel = Type.Enum(CHILD_RELATIONSHIPS);
export const RelationshipType = Type.Enum(RELATIONSHIP_TYPES);

export const PeopleQuery = Type.Object({
  sort: Type.Optional(Type.Enum(['surname', 'given', 'birth', 'death'])),
  dir: Type.Optional(Type.Enum(['asc', 'desc'])),
  sex: Type.Optional(Sex),
  /** Comma-separated living statuses. */
  living: Type.Optional(Type.String({ maxLength: 100, pattern: '^[a-z_]+(,[a-z_]+)*$' })),
  tag: Type.Optional(Id),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const ExportQuery = Type.Object(
  {
    version: Type.Optional(Type.Enum(['5.5.1', '7'])),
    privatize: Type.Optional(Type.Boolean()),
  },
  strict,
);

export const GedzipQuery = Type.Object({ privatize: Type.Optional(Type.Boolean()) }, strict);

export const NeighborhoodQuery = Type.Object({
  focus: Type.Optional(Id),
  up: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  down: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  siblings: Type.Optional(Type.Boolean()),
  /** 0 none, 1 the focus person's siblings (default), 2 also aunts and uncles, ... */
  siblingsDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
});

/** What `from` is to `to`; `to` defaults to the home person. */
export const RelationshipQuery = Type.Object({
  from: Id,
  to: Type.Optional(Id),
});

export const SearchQuery = Type.Object({
  q: Type.String({ maxLength: 200 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const HistoryQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

export const HomeBody = Type.Object({ personId: Type.Union([Id, Type.Null()]) }, strict);

// ---------------------------------------------------------------- people

const nameFields = {
  type: Type.Optional(Type.Enum(NAME_TYPES)),
  given: Type.Optional(nullableText(200)),
  surname: Type.Optional(nullableText(200)),
  surname_prefix: Type.Optional(nullableText(50)),
  prefix: Type.Optional(nullableText(50)),
  suffix: Type.Optional(nullableText(50)),
  nickname: Type.Optional(nullableText(100)),
  is_primary: Type.Optional(Type.Boolean()),
};
export const NameBody = Type.Object(nameFields, strict);
export type NameBody = Static<typeof NameBody>;

const eventFields = {
  /** GEDCOM tag (BIRT, DEAT, MARR, ...) or EVEN with custom_type. */
  type: Type.String({ minLength: 1, maxLength: 32, pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }),
  custom_type: Type.Optional(nullableText(100)),
  /** The date as typed; parsed by packages/core into the sortable columns. */
  date_text: Type.Optional(nullableText(100)),
  /** Full place name; reuses an existing place with the same name. */
  place: Type.Optional(nullableText(500)),
  value: Type.Optional(nullableText(1000)),
  description: Type.Optional(nullableText(2000)),
  age: Type.Optional(nullableText(50)),
  cause: Type.Optional(nullableText(500)),
  privacy: Type.Optional(Privacy),
};
export const EventBody = Type.Object(
  { ...eventFields, role: Type.Optional(Type.Enum(EVENT_ROLES)) },
  strict,
);
export type EventBody = Static<typeof EventBody>;
export const EventPatch = Type.Object(
  { ...eventFields, type: Type.Optional(eventFields.type) },
  strict,
);
export type EventPatch = Static<typeof EventPatch>;

export const PersonBody = Type.Object(
  {
    sex: Type.Optional(Sex),
    living: Type.Optional(Living),
    privacy: Type.Optional(Privacy),
    names: Type.Optional(Type.Array(NameBody, { maxItems: 20 })),
    events: Type.Optional(Type.Array(EventBody, { maxItems: 50 })),
  },
  strict,
);
export type PersonBody = Static<typeof PersonBody>;

export const PersonPatch = Type.Object(
  {
    sex: Type.Optional(Sex),
    living: Type.Optional(Living),
    privacy: Type.Optional(Privacy),
    primary_media_id: Type.Optional(Type.Union([Id, Type.Null()])),
  },
  strict,
);

// ---------------------------------------------------------------- relationships

/** Either an existing person (`personId`) or a new one (`person`). */
const relative = {
  personId: Type.Optional(Id),
  person: Type.Optional(PersonBody),
};

export const AddParentBody = Type.Object(
  { ...relative, familyId: Type.Optional(Id), rel: Type.Optional(ChildRel) },
  strict,
);
export type AddParentBody = Static<typeof AddParentBody>;
export const AddChildBody = Type.Object(
  {
    ...relative,
    familyId: Type.Optional(Id),
    partner1_rel: Type.Optional(ChildRel),
    partner2_rel: Type.Optional(ChildRel),
  },
  strict,
);
export const AddSpouseBody = Type.Object(
  { ...relative, relationship_type: Type.Optional(RelationshipType) },
  strict,
);
export const AddSiblingBody = Type.Object(relative, strict);
export type RelativeBody = Static<typeof AddSiblingBody>;

export const FamilyPatch = Type.Object(
  {
    relationship_type: Type.Optional(RelationshipType),
    partner1_id: Type.Optional(Type.Union([Id, Type.Null()])),
    partner2_id: Type.Optional(Type.Union([Id, Type.Null()])),
    privacy: Type.Optional(Privacy),
  },
  strict,
);

export const FamilyChildPatch = Type.Object(
  {
    partner1_rel: Type.Optional(ChildRel),
    partner2_rel: Type.Optional(ChildRel),
    sort_order: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
    /** Makes this the child's preferred parent set. */
    is_preferred: Type.Optional(Type.Literal(true)),
  },
  strict,
);

// ---------------------------------------------------------------- notes and tags

export const NoteBody = Type.Object(
  { text: text(100_000), owner_type: Type.Enum(NOTE_OWNERS), owner_id: Id },
  strict,
);
export const NotePatch = Type.Object({ text: text(100_000) }, strict);

const tagFields = {
  name: Type.String({ minLength: 1, maxLength: 100 }),
  category: Type.Optional(text(100)),
  color: Type.Optional(
    Type.Union([Type.String({ maxLength: 32, pattern: '^[#A-Za-z0-9(),.% -]+$' }), Type.Null()]),
  ),
};
export const TagBody = Type.Object(tagFields, strict);
export const TagPatch = Type.Object({ ...tagFields, name: Type.Optional(tagFields.name) }, strict);
export const PersonTagBody = Type.Object({ tagId: Id }, strict);
export const PersonTagParams = Type.Object({ tree: TreeParams.properties.tree, id: Id, tagId: Id });

export const MediaThumbParams = Type.Object({
  tree: TreeParams.properties.tree,
  id: Id,
  size: Type.String({ maxLength: 16 }),
});

// ---------------------------------------------------------------- batch

const op = <K extends string, P extends TProperties>(name: K, props: P) =>
  Type.Object({ op: Type.Literal(name), ...props }, strict);

/** Edits that can be grouped into one change batch (one undo step). */
export const BatchOperation = Type.Union([
  op('person.update', { id: Id, patch: PersonPatch }),
  op('name.add', { personId: Id, name: NameBody }),
  op('name.update', { id: Id, name: NameBody }),
  op('name.delete', { id: Id }),
  op('familyChild.update', { id: Id, patch: FamilyChildPatch }),
  op('tag.create', { tag: TagBody, attachTo: Type.Optional(Id) }),
  op('person.tag', { personId: Id, tagId: Id }),
  op('person.untag', { personId: Id, tagId: Id }),
]);
export type BatchOperation = Static<typeof BatchOperation>;

export const BatchBody = Type.Object(
  {
    /** Shown in history and undo toasts, e.g. `Edit Ada Vale`. */
    label: Type.String({ minLength: 1, maxLength: 100 }),
    operations: Type.Array(BatchOperation, { minItems: 1, maxItems: 100 }),
  },
  strict,
);
