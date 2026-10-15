import type * as Source from './schemas.source';
import generated from './schemas.generated.json';

/*
 * Request schemas. Fastify validates every route's params, query and body
 * against these (unknown body properties are rejected). They are written with
 * TypeBox in schemas.source.ts, which also types the handlers, but loaded here
 * as pre-built JSON so the server never imports TypeBox at runtime (issue
 * #54). After editing schemas.source.ts run `npm run generate:schemas -w
 * @open-ancestry/server`; schemas.test.ts fails until the JSON matches.
 */

const schemas = generated as unknown as { [K in keyof typeof Source]: (typeof Source)[K] };

export const {
  Id,
  TreeParams,
  TreeIdParams,
  JobParams,
  ReimportApplyBody,
  TreeBody,
  Sex,
  Living,
  Privacy,
  ChildRel,
  RelationshipType,
  PeopleQuery,
  ExportQuery,
  GedzipQuery,
  NeighborhoodQuery,
  RelationshipQuery,
  SearchQuery,
  HistoryQuery,
  HomeBody,
  NameBody,
  EventBody,
  EventPatch,
  PersonBody,
  PersonPatch,
  AddParentBody,
  AddChildBody,
  AddSpouseBody,
  AddSiblingBody,
  FamilyPatch,
  FamilyChildPatch,
  NoteBody,
  NotePatch,
  TagBody,
  TagPatch,
  PersonTagBody,
  PersonTagParams,
  MediaThumbParams,
  BatchOperation,
  BatchBody,
  CheckKey,
  DismissBody,
  MergeBody,
} = schemas;

export type NameBody = Source.NameBody;
export type EventBody = Source.EventBody;
export type EventPatch = Source.EventPatch;
export type PersonBody = Source.PersonBody;
export type AddParentBody = Source.AddParentBody;
export type RelativeBody = Source.RelativeBody;
export type BatchOperation = Source.BatchOperation;
