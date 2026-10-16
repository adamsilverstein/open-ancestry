export { applyReimport, ReimportStaleError, type ApplyResult } from './apply';
export type {
  FactView,
  PersonReview,
  PlaceRenameReview,
  ReimportChange,
  ReimportDiff,
  ReviewChange,
} from './diff';
export { localHistory, type LocalHistory } from './diff';
export {
  HIGH_CONFIDENCE,
  MATCH_THRESHOLD,
  jaroWinkler,
  detectPlaceRenames,
  matchPeople,
  POSSIBLE_MATCH,
  type PlaceRename,
  type NearMiss,
  type PersonMatch,
} from './match';
export {
  closeReimport,
  isReimportStale,
  prepareReimport,
  refreshReimport,
  reimportData,
  reimportFromData,
  type ReimportData,
  type ReimportPhase,
  type ReimportSession,
} from './session';
