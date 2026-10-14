import { apiGet, apiSend, seg } from '../../api/client';

/** Mirrors packages/import's re-import review (structural types; nothing from it is bundled). */
export interface FactView {
  type: string;
  customType: string | null;
  date: string | null;
  place: string | null;
  value: string | null;
}

export type ReviewChange = {
  id: string;
  defaultAccept: boolean;
  applicable: boolean;
  conflict?: 'local-edit' | 'local-delete';
  requires?: string[];
} & (
  | { kind: 'person.new'; incomingId: string }
  | { kind: 'sex'; before: string; after: string }
  | { kind: 'name.add'; name: string; nameType: string | null }
  | { kind: 'fact.add'; fact: FactView; owner: 'person' | 'family' }
  | { kind: 'fact.change'; before: FactView; after: FactView }
  | { kind: 'fact.missing'; fact: FactView }
  | { kind: 'citation.add'; source: string; page: string | null; apid: string | null }
  | { kind: 'tag.add'; tag: string }
  | { kind: 'media.add'; title: string | null }
  | { kind: 'family.add'; partnerNames: string[] }
  | { kind: 'child.add'; parentNames: string[] }
  | { kind: 'person.missing' }
  | { kind: 'family.missing'; partnerNames: string[] }
  | { kind: 'child.missing'; parentNames: string[] }
  | { kind: 'deleted-here' }
  | { kind: 'merged'; incomingName: string }
  | { kind: 'possibly-merged'; existingName: string }
  | { kind: 'possible-match'; existingName: string }
  | { kind: 'unlinked-new' }
);

export interface PersonReview {
  key: string;
  status: 'matched' | 'new' | 'missing';
  existingId: string | null;
  incomingId: string | null;
  name: string;
  lifespan: string;
  confidence: number | null;
  reasons: string[];
  changes: ReviewChange[];
}

export interface ReimportReview {
  id: string;
  tree: string;
  fileName: string;
  source: { system: string | null; version: string | null };
  warningCount: number;
  diff: {
    people: PersonReview[];
    counts: {
      incoming: number;
      matched: number;
      highConfidence: number;
      changedPeople: number;
      newPeople: number;
      missingPeople: number;
      changes: number;
    };
  };
}

/** Matches at or above this are safe to accept in bulk (packages/import HIGH_CONFIDENCE). */
export const HIGH_CONFIDENCE = 0.85;

export function startReimport(tree: string, file: File): Promise<{ jobId: string }> {
  const form = new FormData();
  form.append('file', file, file.name);
  return apiSend('POST', `/trees/${seg(tree)}/reimport`, form);
}

export const getReimport = (id: string, signal?: AbortSignal) =>
  apiGet<ReimportReview>(`/reimports/${seg(id)}`, signal);

export const applyReimport = (id: string, accept: string[]) =>
  apiSend<{ batchId: string; applied: number; skipped: number; blocked: string[] }>(
    'POST',
    `/reimports/${seg(id)}/apply`,
    { accept },
  );

export const discardReimport = (id: string) => apiSend<void>('DELETE', `/reimports/${seg(id)}`);
