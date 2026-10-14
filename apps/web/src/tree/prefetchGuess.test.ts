import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrefetchGuess } from './prefetchGuess';

/** A fetch the test settles by hand. */
function fetchFor(request: string) {
  let settle!: () => void;
  const done = new Promise<void>((resolve) => (settle = resolve));
  return { start: vi.fn(() => ({ request, done })), settle };
}

describe('PrefetchGuess', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts only after the dwell, and a newer guess replaces a waiting one', () => {
    const cancel = vi.fn();
    const guess = new PrefetchGuess<string>(120, cancel);
    const a = fetchFor('a');
    const b = fetchFor('b');
    guess.next(a.start);
    vi.advanceTimersByTime(100);
    guess.next(b.start);
    vi.advanceTimersByTime(120);
    expect(a.start).not.toHaveBeenCalled();
    expect(b.start).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels the previous fetch when a newer guess comes along', () => {
    const cancel = vi.fn();
    const guess = new PrefetchGuess<string>(120, cancel);
    guess.next(fetchFor('a').start);
    vi.advanceTimersByTime(120);
    guess.next(fetchFor('b').start);
    expect(cancel).toHaveBeenCalledWith('a');
  });

  it('does not cancel a finished fetch', async () => {
    const cancel = vi.fn();
    const guess = new PrefetchGuess<string>(120, cancel);
    const a = fetchFor('a');
    guess.next(a.start);
    vi.advanceTimersByTime(120);
    a.settle();
    await vi.runAllTimersAsync();
    guess.next(fetchFor('b').start);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('never cancels a fetch a re-focus adopted, even when the next guess starts', () => {
    const cancel = vi.fn();
    const guess = new PrefetchGuess<string>(120, cancel);
    guess.next(fetchFor('a').start);
    vi.advanceTimersByTime(120);
    // Double click on the guessed person: the re-focus now awaits the same query.
    guess.adopt();
    // Then the pointer rests on another card.
    guess.next(fetchFor('b').start);
    vi.advanceTimersByTime(120);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('adopting stops a guess still waiting out its dwell', () => {
    const guess = new PrefetchGuess<string>(120, vi.fn());
    const a = fetchFor('a');
    guess.next(a.start);
    guess.adopt();
    vi.advanceTimersByTime(500);
    expect(a.start).not.toHaveBeenCalled();
  });
});
