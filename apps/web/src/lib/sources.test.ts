import { describe, expect, it } from 'vitest';
import { fixtureDetail } from './fixtureDetail.test-utils';
import { collectCitations, groupBySource } from './sources';

describe('collectCitations', () => {
  const cited = collectCitations(fixtureDetail('rowan'));

  it('lists person and event citations once, with what they support', () => {
    expect(cited.map((c) => [c.detail.source.title, c.citedFor])).toEqual([
      ['Ashdown Family Bible', ['this person']],
      ['Brackenford Parish Register', ['Birth']],
      ['1911 Northvale Census', ['Census']],
    ]);
  });

  it('links Ancestry records and only safe URLs', () => {
    expect(cited[2]!.link).toEqual({
      href: 'https://www.ancestry.com/discoveryui-content/view/30542144:7572',
      label: 'View record on Ancestry',
    });
    expect(cited[0]!.link).toBeNull();
    const [first] = cited;
    const withUrl = (url: string) =>
      collectCitations({
        ...fixtureDetail('rowan'),
        events: [],
        citations: [{ ...first!.detail, citation: { ...first!.detail.citation, url } }],
      })[0]!.link;
    expect(withUrl('https://records.example.org/1')).toEqual({
      href: 'https://records.example.org/1',
      label: 'View record',
    });
    expect(withUrl('javascript:alert(1)')).toBeNull();
  });

  it('groups by source', () => {
    expect(groupBySource([...cited, cited[0]!]).map((g) => [g.title, g.items.length])).toEqual([
      ['Ashdown Family Bible', 2],
      ['Brackenford Parish Register', 1],
      ['1911 Northvale Census', 1],
    ]);
  });
});
