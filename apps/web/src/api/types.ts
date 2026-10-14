/*
 * API response types. Reads return packages/db DTOs (docs/api.md), so the
 * types come from there; type-only, nothing from db is bundled.
 */
export type {
  CitationDetail,
  EventBrief,
  EventDetail,
  Neighborhood,
  ParentFamily,
  PartnerFamily,
  PersonDetail,
  PersonSummary as ApiPersonSummary,
  RelativeLink,
} from '@open-ancestry/db';
