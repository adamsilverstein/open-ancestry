import { describe, expect, it } from 'vitest';
import { fromNeighborhood, layoutFamily } from './index';
import type { NeighborhoodInput, NeighborhoodPerson } from './index';

const person = (
  id: string,
  sex: 'M' | 'F',
  extra: Partial<NeighborhoodPerson> = {},
): NeighborhoodPerson => ({
  id,
  sex,
  living: 'dead',
  given: id.toUpperCase(),
  surname: 'Example',
  birth: null,
  death: null,
  ...extra,
});

// The shape `getNeighborhood` in packages/db returns (synthetic people).
const result: NeighborhoodInput = {
  people: [
    person('me', 'F', { living: 'inferred_living', birth: { dateSort: 19850315 } }),
    person('dad', 'M', { birth: { dateSort: 19500101 }, death: { dateSort: 20100101 } }),
    person('mom', 'F', { prefix: 'Dr.', birth: { dateSort: 19520101 } }),
    person('adad', 'M'),
    person('sis', 'F', { living: 'living', birth: { dateSort: 19800101 }, given: null }),
    person('h1', 'M', { death: { dateSort: 19990101 } }),
    person('h2', 'M', { living: 'living' }),
  ],
  families: [
    {
      id: 'F_adopt',
      partner1Id: 'adad',
      partner2Id: null,
      relationshipType: 'unknown',
      partner1Order: 0,
      partner2Order: 0,
    },
    {
      id: 'F_bio',
      partner1Id: 'dad',
      partner2Id: 'mom',
      relationshipType: 'married',
      partner1Order: 0,
      partner2Order: 0,
    },
    // Listed first but her second marriage (partner2Order 1).
    {
      id: 'F_h2',
      partner1Id: 'h2',
      partner2Id: 'me',
      relationshipType: 'partners',
      partner1Order: 0,
      partner2Order: 1,
    },
    {
      id: 'F_h1',
      partner1Id: 'h1',
      partner2Id: 'me',
      relationshipType: 'married',
      partner1Order: 0,
      partner2Order: 0,
    },
  ],
  children: [
    {
      familyId: 'F_bio',
      childId: 'me',
      partner1Rel: 'biological',
      partner2Rel: 'biological',
      sortOrder: 1,
      childOrder: 1,
      isPreferred: false,
    },
    {
      familyId: 'F_bio',
      childId: 'sis',
      partner1Rel: 'biological',
      partner2Rel: 'biological',
      sortOrder: 0,
      childOrder: 0,
      isPreferred: true,
    },
    {
      familyId: 'F_adopt',
      childId: 'me',
      partner1Rel: 'adopted',
      partner2Rel: 'adopted',
      sortOrder: 0,
      childOrder: 0,
      isPreferred: true,
    },
  ],
  moreUp: ['dad'],
  moreDown: ['sis'],
};

describe('fromNeighborhood', () => {
  it('maps people, names, lifespans and lazy-load hints', () => {
    const graph = fromNeighborhood(result);
    const people = graph.people as Map<string, unknown>;
    expect(people.get('me')).toEqual({
      id: 'me',
      sex: 'F',
      name: 'ME Example',
      living: true,
      lifespan: '1985–Living',
      birthSortKey: 19850315,
    });
    expect(people.get('dad')).toMatchObject({
      lifespan: '1950–2010',
      hasMoreParents: true,
      living: false,
    });
    expect(people.get('mom')).toMatchObject({ name: 'Dr. MOM Example', lifespan: 'b. 1952' });
    expect(people.get('sis')).toMatchObject({ name: 'Example', hasMoreChildren: true });
    expect(people.get('h1')).toMatchObject({ lifespan: 'd. 1999' });
    expect(people.get('h2')).toMatchObject({ lifespan: 'Living' });
    expect(people.get('adad')).not.toHaveProperty('lifespan');
  });

  it('orders children by sortOrder and keeps preferred parents and relationship types', () => {
    const graph = fromNeighborhood(result);
    const bio = graph.families.find((f) => f.id === 'F_bio')!;
    expect(bio.children.map((c) => c.id)).toEqual(['sis', 'me']);
    expect(bio.relationship).toBe('married');
    expect(graph.families.find((f) => f.id === 'F_h2')!.partnerOrder).toEqual([0, 1]);
  });

  it('feeds the layout: preferred parent set, partner order and couple styles', () => {
    const layout = layoutFamily(fromNeighborhood(result), 'me');
    // The adoptive family is marked preferred, so it wins over the biological one.
    expect(layout.alternateParentFamilies['me']).toEqual({
      selected: 'F_adopt',
      families: ['F_adopt', 'F_bio'],
    });
    expect(layout.nodes.map((n) => n.key)).toContain('adad');
    // First marriage (h1) on the left, second (h2) on the right.
    const row = layout.nodes.filter((n) => n.generation === 0).sort((a, b) => a.x - b.x);
    expect(row.map((n) => n.key)).toEqual(['h1', 'me', 'h2']);
    const couples = layout.edges.filter((e) => e.kind === 'couple');
    expect(couples.find((e) => e.familyId === 'F_h2')?.relationship).toBe('partners');
  });
});
