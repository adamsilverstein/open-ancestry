import type { CitationDetail, PersonDetail } from '../api/types';
import { ancestryRecordUrl } from './apid';
import { eventLabel } from './timeline';

export interface CitedSource {
  detail: CitationDetail;
  /** What the citation supports: `Person`, `Birth`, `Census`... */
  citedFor: string[];
  /** Safe external link: an http(s) citation URL, else the Ancestry record. */
  link: { href: string; label: string } | null;
}

function externalLink({ citation, source }: CitationDetail): CitedSource['link'] {
  if (citation.url && /^https?:\/\//i.test(citation.url)) {
    return { href: citation.url, label: 'View record' };
  }
  const ancestry = ancestryRecordUrl(citation.apid) ?? ancestryRecordUrl(source.apid);
  return ancestry ? { href: ancestry, label: 'View record on Ancestry' } : null;
}

/** Every citation on the person and their events, once each, in page order. */
export function collectCitations(detail: PersonDetail): CitedSource[] {
  const byId = new Map<string, CitedSource>();
  const add = (item: CitationDetail, what: string) => {
    const existing = byId.get(item.citation.id);
    if (existing) {
      if (!existing.citedFor.includes(what)) existing.citedFor.push(what);
      return;
    }
    byId.set(item.citation.id, { detail: item, citedFor: [what], link: externalLink(item) });
  };
  for (const item of detail.citations) add(item, 'Person');
  for (const { event, citations } of detail.events) {
    for (const item of citations) add(item, eventLabel(event.type, event.custom_type));
  }
  for (const family of detail.partnerFamilies) {
    for (const { event, citations } of family.events) {
      for (const item of citations) add(item, eventLabel(event.type, event.custom_type));
    }
  }
  return [...byId.values()];
}

/** Citations grouped by source title, sources in first-cited order. */
export function groupBySource(
  cited: CitedSource[],
): { title: string; id: string; items: CitedSource[] }[] {
  const groups = new Map<string, { title: string; id: string; items: CitedSource[] }>();
  for (const item of cited) {
    const { source } = item.detail;
    const group = groups.get(source.id) ?? { title: source.title, id: source.id, items: [] };
    group.items.push(item);
    groups.set(source.id, group);
  }
  return [...groups.values()];
}
