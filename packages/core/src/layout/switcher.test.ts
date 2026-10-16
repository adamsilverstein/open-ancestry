import { describe, expect, it } from 'vitest';
import { layoutFamily } from './index';
import { makeGraph } from './test-graphs';

describe('parent-set switcher with a partnerless family', () => {
  it('reaches every parent set by cycling, as TreeView.onSwitchParents does', () => {
    // A GEDCOM FAM with only CHIL lines sits between the birth and adoptive families.
    const g = makeGraph({ me: 'M', p: 'M', q: 'F', r: 'M', s: 'F', sib: 'F' }, [
      ['F1', 'p', 'q', ['me']],
      ['F2', null, null, ['me', 'sib']],
      ['F3', 'r', 's', [['me', 'adopted']]],
    ]);
    const seen = new Set<string>();
    let selected: Record<string, string> = {};
    for (let click = 0; click < 6; click++) {
      const choice = layoutFamily(g, 'me', { selectedParentFamilies: selected })
        .alternateParentFamilies.me!;
      seen.add(choice.selected);
      // TreeView.onSwitchParents: the family after the one shown.
      const next =
        choice.families[(choice.families.indexOf(choice.selected) + 1) % choice.families.length]!;
      selected = { me: next };
    }
    expect(seen).toContain('F3');
  });
});
