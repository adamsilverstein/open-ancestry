export { applyReimport, ReimportStaleError, type ApplyResult } from './apply';
export type { FactView, PersonReview, ReimportChange, ReimportDiff, ReviewChange } from './diff';
export {
  HIGH_CONFIDENCE,
  MATCH_THRESHOLD,
  jaroWinkler,
  matchPeople,
  type PersonMatch,
} from './match';
export { closeReimport, prepareReimport, type ReimportSession } from './session';
