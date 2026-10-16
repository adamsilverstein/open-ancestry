import { describe, expect, it } from 'vitest';
import { describeResults, type PaletteAction } from './CommandPalette';

const item = (id: string): PaletteAction => ({ id, label: id, onSelect: () => undefined });

describe('describeResults', () => {
  const ada = item('ada');
  const bram = item('bram');
  const theme = item('theme');
  const groups = [
    { heading: 'People', items: [ada, bram] },
    { heading: 'Actions', items: [theme] },
  ];

  it('counts what is shown in each group, singular and plural', () => {
    expect(describeResults(groups, [ada, bram, theme])).toBe('2 people, 1 action');
    expect(describeResults(groups, [ada])).toBe('1 person');
  });

  it('says when nothing is shown', () => {
    expect(describeResults(groups, [])).toBe('No results');
  });
});
