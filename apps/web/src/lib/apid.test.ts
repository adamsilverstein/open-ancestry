import { describe, expect, it } from 'vitest';
import { ancestryRecordUrl } from './apid';

describe('ancestryRecordUrl', () => {
  it('links a record APID to its Ancestry record page', () => {
    expect(ancestryRecordUrl('1,7572::30542144')).toBe(
      'https://www.ancestry.com/discoveryui-content/view/30542144:7572',
    );
  });

  it('links a database-only APID to the collection', () => {
    expect(ancestryRecordUrl('1,7572::0')).toBe(
      'https://www.ancestry.com/search/collections/7572/',
    );
  });

  it('rejects anything else', () => {
    expect(ancestryRecordUrl(null)).toBeNull();
    expect(ancestryRecordUrl('')).toBeNull();
    expect(ancestryRecordUrl('javascript:alert(1)')).toBeNull();
    expect(ancestryRecordUrl('1,abc::12')).toBeNull();
  });
});
