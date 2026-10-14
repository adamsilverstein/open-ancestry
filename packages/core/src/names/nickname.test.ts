import { describe, expect, it } from 'vitest';
import { replaceNickname } from './index';

describe('replaceNickname', () => {
  it.each<[string, string | null, string | null, string]>([
    // Straight, curly and parenthesized nicknames keep their marks.
    ['Ann "Nan" /Ash/', 'Nan', 'Tad', 'Ann "Tad" /Ash/'],
    ['Ann “Nan” /Ash/', 'Nan', 'Tad', 'Ann “Tad” /Ash/'],
    ['Ann (Nan) /Ash/', 'Nan', 'Tad', 'Ann (Tad) /Ash/'],
    // Cleared: the marks go with it.
    ['Ann "Nan" /Ash/', 'Nan', null, 'Ann /Ash/'],
    ['Ann (Nan) /Ash/', 'Nan', '', 'Ann /Ash/'],
    ['Ann “Nan” /Ash/', 'Nan', null, 'Ann /Ash/'],
    // A text that never spelled out a nickname is left as it is (GEDCOM NICK carries it).
    ['Ann /Ash/', null, 'Tad', 'Ann /Ash/'],
    // Parentheses that are not the nickname are left alone.
    ['John (Jr.) /Ash/', 'Nan', 'Tad', 'John (Jr.) /Ash/'],
    // A quoted nickname that no longer matches the column is still the nickname.
    ['Ann "Nannie" /Ash/', 'Nan', 'Tad', 'Ann "Tad" /Ash/'],
    // Nothing to do.
    ['Ann /Ash/', null, null, 'Ann /Ash/'],
  ])('%j, %j -> %j gives %j', (text, previous, next, expected) => {
    expect(replaceNickname(text, previous, next)).toBe(expected);
  });
});
