import { describe, expect, it } from 'vitest';
import type { Neighborhood } from '../api/types';
import { describeRelationship, relationshipPath } from './relationship';

/** Builds an ancestors-only neighborhood from child -> [parents] pairs. */
function slice(focusId: string, parents: Record<string, string[]>, sexes: Record<string, string>) {
  const families: Neighborhood['families'] = [];
  const children: Neighborhood['children'] = [];
  for (const [child, [p1, p2]] of Object.entries(parents)) {
    // Siblings share their parents' family, as in the database.
    const id = `F-${p1}+${p2}`;
    if (!families.some((f) => f.id === id))
      families.push({
        id,
        partner1Id: p1 ?? null,
        partner2Id: p2 ?? null,
        relationshipType: 'married',
        partner1Order: 0,
        partner2Order: 0,
      });
    children.push({
      familyId: id,
      childId: child,
      partner1Rel: 'biological',
      partner2Rel: 'biological',
      sortOrder: 0,
      childOrder: 0,
      isPreferred: true,
    });
  }
  const ids = new Set([focusId, ...Object.keys(parents), ...Object.values(parents).flat()]);
  return {
    focusId,
    people: [...ids].map((id) => ({ id, sex: sexes[id] ?? 'U' })),
    families,
    children,
    moreUp: [],
    moreDown: [],
    truncated: false,
  } as unknown as Neighborhood;
}

describe('describeRelationship', () => {
  const sexes = { gpa: 'M', dad: 'M', mom: 'F', uncle: 'M', me: 'M', cousin: 'F', sis: 'F' };
  const tree: Record<string, string[]> = {
    me: ['dad', 'mom'],
    sis: ['dad', 'mom'],
    dad: ['gpa'],
    uncle: ['gpa'],
    cousin: ['uncle'],
  };
  const from = (id: string) => slice(id, pick(tree, id), sexes);
  function pick(all: Record<string, string[]>, id: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const walk = (p: string) => {
      if (!all[p]) return;
      out[p] = all[p];
      all[p].forEach(walk);
    };
    walk(id);
    return out;
  }

  it('finds ancestors, siblings and cousins through common ancestors', () => {
    expect(describeRelationship(from('me'), from('dad'))).toBe('father');
    expect(describeRelationship(from('me'), from('gpa'))).toBe('grandfather');
    expect(describeRelationship(from('me'), from('sis'))).toBe('sister');
    expect(describeRelationship(from('me'), from('cousin'))).toBe('1st cousin');
    expect(describeRelationship(from('cousin'), from('me'))).toBe('1st cousin');
    expect(describeRelationship(from('dad'), from('me'))).toBe('son');
    expect(describeRelationship(from('me'), from('uncle'))).toBe('uncle');
    expect(describeRelationship(from('me'), from('me'))).toBe('self');
  });

  it('detects half siblings from a single shared parent', () => {
    const half = { a: ['p1', 'p2'], b: ['p1', 'p3'] };
    expect(
      describeRelationship(slice('a', { a: half.a }, {}), slice('b', { b: half.b }, { b: 'M' })),
    ).toBe('half brother');
  });

  it('returns null when no blood relationship is found', () => {
    expect(describeRelationship(slice('x', {}, {}), slice('y', {}, {}))).toBeNull();
  });
});

describe('relationshipPath', () => {
  const sexes = { gpa: 'M', dad: 'M', uncle: 'M', me: 'M', cousin: 'F' };
  const both = (id: string, parents: Record<string, string[]>) => slice(id, parents, sexes);

  it('returns chart cells from the person to home, marking the common ancestor', () => {
    const r = relationshipPath(
      both('me', { me: ['dad'], dad: ['gpa'] }),
      both('cousin', { cousin: ['uncle'], uncle: ['gpa'] }),
    );
    expect(r?.name).toBe('1st cousin');
    expect(r?.cells).toEqual([
      { id: 'cousin', row: 2, col: 0, role: 'person' },
      { id: 'uncle', row: 1, col: 0, role: 'between' },
      { id: 'gpa', row: 0, col: 0, role: 'common-ancestor' },
      { id: 'dad', row: 1, col: 1, role: 'between' },
      { id: 'me', row: 2, col: 1, role: 'home' },
    ]);
  });

  it('is null for the home person and for strangers', () => {
    expect(relationshipPath(both('me', {}), both('me', {}))).toBeNull();
    expect(relationshipPath(both('me', {}), both('x', {}))).toBeNull();
  });
});
