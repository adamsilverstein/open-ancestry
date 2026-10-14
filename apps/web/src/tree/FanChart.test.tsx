import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FanLayout, FanSegment } from '@open-ancestry/core';
import type { PersonSummary } from '../lib/person';
import { FanChart } from './FanChart';

const segment = (
  key: string,
  ahnentafel: number,
  generation: number,
  startAngle: number,
  endAngle: number,
): FanSegment => ({
  key,
  personId: key,
  generation,
  ahnentafel,
  startAngle,
  endAngle,
  innerRadius: generation === 0 ? 0 : 60 + (generation - 1) * 70,
  outerRadius: 60 + generation * 70,
  isFocus: generation === 0,
  isDuplicate: false,
});

/** Ada at the center, Bram (father) and Elsa (mother) around her. */
const makeFan = (): FanLayout => ({
  focusKey: 'ada',
  segments: [
    segment('ada', 1, 0, Math.PI, 2 * Math.PI),
    segment('bram', 2, 1, Math.PI, 1.5 * Math.PI),
    segment('elsa', 3, 1, 1.5 * Math.PI, 2 * Math.PI),
  ],
  emptySlots: [],
  bounds: { minX: -130, minY: -130, maxX: 130, maxY: 0, width: 260, height: 130 },
  alternateParentFamilies: {},
});

const people: Record<string, PersonSummary> = {
  ada: { id: 'ada', name: 'Ada Vale', sex: 'F' },
  bram: { id: 'bram', name: 'Bram Vale', sex: 'M' },
  elsa: { id: 'elsa', name: 'Elsa Hale', sex: 'F' },
};

const tabStop = () =>
  screen.getAllByRole('button').filter((b) => b.getAttribute('tabindex') === '0');

describe('FanChart keyboard', () => {
  afterEach(cleanup);

  it('skips segments whose person is not loaded (they are not drawn)', () => {
    const fan = makeFan();
    // Bram's details are not loaded yet: his segment is not drawn.
    const person = (id: string) => (id === 'bram' ? undefined : people[id]);
    render(<FanChart fan={fan} focusPersonId="ada" person={person} onRefocus={vi.fn()} />);
    const svg = screen.getByTestId('tree-fan');
    fireEvent.keyDown(svg, { key: 'ArrowUp' });
    // Up goes to the mother, the drawn parent, and the fan keeps one tab stop.
    expect(tabStop().map((b) => b.dataset.key)).toEqual(['elsa']);
  });

  it('keeps the tab stop on the same person when the fan is rebuilt', () => {
    const person = (id: string) => people[id];
    const { rerender } = render(
      <FanChart fan={makeFan()} focusPersonId="ada" person={person} onRefocus={vi.fn()} />,
    );
    fireEvent.keyDown(screen.getByTestId('tree-fan'), { key: 'ArrowUp' });
    expect(tabStop().map((b) => b.dataset.key)).toEqual(['bram']);
    // A reload lays the same fan out again as a new object.
    rerender(<FanChart fan={makeFan()} focusPersonId="ada" person={person} onRefocus={vi.fn()} />);
    expect(tabStop().map((b) => b.dataset.key)).toEqual(['bram']);
  });

  it('starts at the center for a new focus person', () => {
    const person = (id: string) => people[id];
    const { rerender } = render(
      <FanChart fan={makeFan()} focusPersonId="ada" person={person} onRefocus={vi.fn()} />,
    );
    fireEvent.keyDown(screen.getByTestId('tree-fan'), { key: 'ArrowUp' });
    const refocused = makeFan();
    refocused.segments = refocused.segments.map((s) => ({ ...s, isFocus: s.key === 'elsa' }));
    rerender(<FanChart fan={refocused} focusPersonId="elsa" person={person} onRefocus={vi.fn()} />);
    expect(tabStop().map((b) => b.dataset.key)).toEqual(['elsa']);
  });
});
