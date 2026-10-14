import { describe, expect, it } from 'vitest';
import type { Neighborhood } from '../api/types';
import { describeRelationship, relationshipName } from './relationship';

describe('relationshipName', () => {
  it('names direct ancestors', () => {
    expect(relationshipName(1, 0, 'M')).toBe('father');
    expect(relationshipName(1, 0, 'F')).toBe('mother');
    expect(relationshipName(1, 0, 'U')).toBe('parent');
    expect(relationshipName(2, 0, 'M')).toBe('grandfather');
    expect(relationshipName(3, 0, 'F')).toBe('great-grandmother');
    expect(relationshipName(4, 0, 'M')).toBe('2nd great-grandfather');
    expect(relationshipName(5, 0, 'M')).toBe('3rd great-grandfather');
    expect(relationshipName(13, 0, 'M')).toBe('11th great-grandfather');
    expect(relationshipName(24, 0, 'M')).toBe('22nd great-grandfather');
  });

  it('names direct descendants', () => {
    expect(relationshipName(0, 1, 'M')).toBe('son');
    expect(relationshipName(0, 1, 'F')).toBe('daughter');
    expect(relationshipName(0, 1, 'X')).toBe('child');
    expect(relationshipName(0, 2, 'M')).toBe('grandson');
    expect(relationshipName(0, 3, 'F')).toBe('great-granddaughter');
    expect(relationshipName(0, 4, 'U')).toBe('2nd great-grandchild');
  });

  it('names siblings, half siblings, nephews and uncles', () => {
    expect(relationshipName(1, 1, 'M')).toBe('brother');
    expect(relationshipName(1, 1, 'F', true)).toBe('half sister');
    expect(relationshipName(1, 1, 'U')).toBe('sibling');
    expect(relationshipName(1, 2, 'M')).toBe('nephew');
    expect(relationshipName(1, 2, 'F')).toBe('niece');
    expect(relationshipName(1, 3, 'M')).toBe('grandnephew');
    expect(relationshipName(1, 4, 'F')).toBe('great-grandniece');
    expect(relationshipName(2, 1, 'M')).toBe('uncle');
    expect(relationshipName(2, 1, 'F')).toBe('aunt');
    expect(relationshipName(3, 1, 'M')).toBe('great-uncle');
    expect(relationshipName(4, 1, 'F')).toBe('2nd great-aunt');
    expect(relationshipName(2, 1, 'U')).toBe('parent’s sibling');
  });

  it('names cousins with degree and removal', () => {
    expect(relationshipName(2, 2, 'M')).toBe('1st cousin');
    expect(relationshipName(3, 3, 'F')).toBe('2nd cousin');
    expect(relationshipName(2, 3, 'M')).toBe('1st cousin 1x removed');
    expect(relationshipName(5, 3, 'M')).toBe('2nd cousin 2x removed');
    expect(relationshipName(2, 2, 'M', true)).toBe('half 1st cousin');
  });

  it('names the home person', () => {
    expect(relationshipName(0, 0, 'M')).toBe('self');
  });
});

/** Builds an ancestors-only neighborhood from child -> [parents] pairs. */
function slice(focusId: string, parents: Record<string, string[]>, sexes: Record<string, string>) {
  const families: Neighborhood['families'] = [];
  const children: Neighborhood['children'] = [];
  for (const [child, [p1, p2]] of Object.entries(parents)) {
    const id = `F-${child}`;
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
