import { describe, expect, it } from 'vitest';
import { foldForIndex, foldForSearch, normalizeForSearch } from '../names/phonetic';
import { displayText, isolate, unsafeTextReason } from './safety';

/* Names, places and dates: no control characters or bidi overrides (#190). */

describe('unsafeTextReason', () => {
  it('accepts ordinary text in any script, with combining marks and emoji', () => {
    for (const text of ['Rowan Ashdown', 'José', 'Zoë', 'שרה', 'محمد', 'é', '👩‍👩‍👧', '']) {
      expect(unsafeTextReason(text), text).toBeNull();
    }
  });

  it('refuses C0 and C1 control characters, tab and newline included', () => {
    for (const char of ['\u0000', '\t', '\n', '\r', '\u001b', '\u007f', '\u0085', '\u009f']) {
      expect(unsafeTextReason(`Ro${char}wan`), JSON.stringify(char)).toMatch(/control character/);
    }
  });

  it('refuses line and paragraph separators and the obsolete format controls', () => {
    for (const char of ['\u2028', '\u2029', '\u206a', '\u206f']) {
      expect(unsafeTextReason(`Ro${char}wan`), JSON.stringify(char)).not.toBeNull();
    }
    expect(displayText('Rowan\u2028Ashdown\u206a')).toBe('Rowan Ashdown');
  });

  it('refuses bidi embeddings and overrides', () => {
    for (const char of ['‪', '‫', '‬', '‭', '‮']) {
      expect(unsafeTextReason(`Evil${char}`), JSON.stringify(char)).toMatch(/direction/);
    }
  });

  it('allows bidi isolates only when they are balanced', () => {
    expect(unsafeTextReason('⁧שרה⁩ Cohen')).toBeNull();
    expect(unsafeTextReason('⁨a⁦b⁩c⁩')).toBeNull();
    expect(unsafeTextReason('⁧שרה Cohen')).toMatch(/isolate/);
    expect(unsafeTextReason('Cohen⁩')).toMatch(/isolate/);
  });
});

describe('displayText', () => {
  it('drops overrides and embeddings so they cannot reorder what follows', () => {
    expect(displayText('Evil‮')).toBe('Evil');
    expect(displayText('‭Rowan‬')).toBe('Rowan');
  });

  it('turns control characters into spaces and drops unbalanced isolates', () => {
    expect(displayText('Rowan\tAsh\ndown\u0000')).toBe('Rowan Ash down');
    expect(displayText('⁧שרה Cohen')).toBe('שרה Cohen');
    expect(displayText('⁧שרה⁩ Cohen')).toBe('⁧שרה⁩ Cohen');
  });

  it('leaves ordinary text alone', () => {
    expect(displayText('Zoë Ashdown')).toBe('Zoë Ashdown');
  });
});

describe('isolate (#264)', () => {
  it('wraps cleaned text in a first-strong isolate, so it cannot reorder what follows', () => {
    expect(isolate('Rowan Ashdown')).toBe('\u2068Rowan Ashdown\u2069');
    expect(isolate('Evil\u202e')).toBe('\u2068Evil\u2069');
    expect(isolate('Cohen\u2069')).toBe('\u2068Cohen\u2069');
    expect(isolate('')).toBe('');
  });
});

describe('search keys', () => {
  it('ignore zero-width and other invisible format characters', () => {
    expect(normalizeForSearch('Ro​wan')).toBe('rowan');
    expect(normalizeForSearch('Ro‍wan﻿')).toBe('rowan');
    expect(normalizeForSearch('Ash­down')).toBe('ashdown');
  });
});

describe('the search fold (#199), shared with re-import matching', () => {
  it('reads common spelling equivalents the same', () => {
    const same: [string, string][] = [
      ['Yılmaz', 'Yilmaz'],
      ['Straße', 'Strasse'],
      ['STRAẞE', 'STRASSE'],
      ['כֹּהֵן', 'כהן'],
      ['عَلِيّ', 'علي'],
      ["O'Brien", 'OBrien'],
      ['O’Brien', 'OBrien'],
    ];
    for (const [a, b] of same) {
      expect(foldForSearch(a), a).toBe(foldForSearch(b));
      expect(normalizeForSearch(a), a).toBe(normalizeForSearch(b));
    }
  });

  it('keeps apostrophes that are not inside a word, and other letters as they are', () => {
    expect(foldForSearch("'Ada'")).toBe("'Ada'");
    expect(foldForSearch('Zoë')).toBe('Zoë');
  });
});

describe('the index fold', () => {
  it('keeps a name with an apostrophe both joined and split', () => {
    expect(foldForIndex("O'Brien Vale")).toBe('OBrien O Brien Vale');
    expect(foldForIndex('Yılmaz')).toBe(foldForSearch('Yılmaz'));
  });

  it('folds Turkish dotted and dotless i to plain i', () => {
    // ş is a Latin diacritic, left to the tokenizer like the others.
    expect(foldForSearch('İnce Işık')).toBe('Ince Işik');
  });
});
