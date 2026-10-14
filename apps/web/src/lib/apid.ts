/**
 * Ancestry `_APID` (`1,7572::30542144`: database 7572, record 30542144) to a
 * link: the record page, or the collection when the record id is 0. Anything
 * else is untrusted text and gets no link.
 */
export function ancestryRecordUrl(apid: string | null | undefined): string | null {
  const match = /^\d+,(\d+)::(\d+)$/.exec(apid?.trim() ?? '');
  if (!match) return null;
  const [, database, record] = match;
  return Number(record) === 0
    ? `https://www.ancestry.com/search/collections/${database}/`
    : `https://www.ancestry.com/discoveryui-content/view/${record}:${database}`;
}
