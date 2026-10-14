import { describe, expect, it } from 'vitest';
import { fixtureDetail } from './fixtureDetail.test-utils';
import { lifeStory } from './lifeStory';

describe('lifeStory', () => {
  it('narrates birth, family, work, marriage, losses and death', () => {
    const story = lifeStory(fixtureDetail('rowan'));
    expect(story).toEqual([
      'Rowan Ashdown was born on 12 Mar 1880 in Brackenford, Westmere, the son of Edmund Ashdown and Clara Penhallow. He had one brother and one sister.',
      'In 1900 he lived in Wexmoor, Westmere. He worked as a blacksmith in 1910.',
      'He married Iris Vale on 14 Jun 1905 in Ashcombe, Eastholm. Together they had two children: Lena and Arthur.',
      'His father, Edmund Ashdown, died in 1901, when Rowan was 21. His mother, Clara Penhallow, died in 1930. His wife, Iris Vale, died in 1940. His son Arthur died in 1944.',
      'He died on 3 Nov 1950 in Thornbury, Northvale, at the age of 70, and was buried in Thornbury, Northvale.',
    ]);
  });

  it('uses the right pronouns and copes with sparse records', () => {
    const lena = lifeStory(fixtureDetail('lena'));
    expect(lena[0]).toBe(
      'Lena Ashdown was born on 30 Sep 1906 in Brackenford, Westmere, the daughter of Rowan Ashdown and Iris Vale. She had one brother.',
    );
    const pip = lifeStory(fixtureDetail('pip'));
    expect(pip[0]).toBe(
      'Pip Ashdown was born in 1935 in Brackenford, Westmere, the son of Arthur Ashdown.',
    );
  });

  it('says so when there is nothing to tell', () => {
    const detail = fixtureDetail('lena');
    expect(lifeStory({ ...detail, events: [], parentFamilies: [], partnerFamilies: [] })).toEqual(
      [],
    );
  });
});

describe('lifeStory losses', () => {
  it('tells deaths in date order, not family order', () => {
    const detail = fixtureDetail('rowan');
    const [family] = detail.parentFamilies;
    const swapped = {
      ...detail,
      parentFamilies: [{ ...family!, partner1: family!.partner2, partner2: family!.partner1 }],
    };
    expect(lifeStory(swapped)[3]).toMatch(/^His father, Edmund Ashdown, died in 1901/);
  });
});
