import { describe, expect, it } from 'vitest';
import { replaceNickname } from './index';

describe('replaceNickname', () => {
  it.each<[string, string | null, string | null, string]>([
    // Straight, curly and parenthesized nicknames keep their marks.
    ['Ann "Nan" /Ash/', 'Nan', 'Tad', 'Ann "Tad" /Ash/'],
    ['Ann “Nan” /Ash/', 'Nan', 'Tad', 'Ann “Tad” /Ash/'],
    ['Ann (Nan) /Ash/', 'Nan', 'Tad', 'Ann (Tad) /Ash/'],
    ['Dr. Ann "Nan" /Ash/ Jr.', 'Nan', 'Tad', 'Dr. Ann "Tad" /Ash/ Jr.'],
    // Cleared: the marks and one space go with it.
    ['Ann "Nan" /Ash/', 'Nan', null, 'Ann /Ash/'],
    ['Ann (Nan) /Ash/', 'Nan', '', 'Ann /Ash/'],
    ['Ann “Nan” /Ash/', 'Nan', null, 'Ann /Ash/'],
    ['"Nan" Ann /Ash/', 'Nan', null, 'Ann /Ash/'],
    // Only the previous nickname is touched: other quoted or parenthesized text stays.
    ['Ann /Ash/ "the elder"', null, 'Tad', 'Ann /Ash/ "the elder"'],
    ['Ann /Ash/ "the elder"', 'Nan', 'Tad', 'Ann /Ash/ "the elder"'],
    // After the surname it is an epithet even when it was read as the nickname.
    ['Ann /Ash/ "the elder"', 'the elder', 'Tad', 'Ann /Ash/ "the elder"'],
    ['Ann "Nan" /Ash/ "the elder"', 'Nan', 'Tad', 'Ann "Tad" /Ash/ "the elder"'],
    ['John (Jr.) /Ash/', 'Nan', 'Tad', 'John (Jr.) /Ash/'],
    ['Ann "Nannie" /Ash/', 'Nan', 'Tad', 'Ann "Nannie" /Ash/'],
    // A text that never spelled out a nickname is left as it is (GEDCOM NICK carries it).
    ['Ann /Ash/', null, 'Tad', 'Ann /Ash/'],
    ['Ann /Ash/', null, null, 'Ann /Ash/'],
    // A new nickname with the marks in it gets other marks, so it reads back unambiguously.
    ['Ann "Nan" /Ash/', 'Nan', 'Big "J"', 'Ann (Big "J") /Ash/'],
    ['Ann (Nan) /Ash/', 'Nan', 'Big (J)', 'Ann “Big (J)” /Ash/'],
  ])('%j, %j -> %j gives %j', (text, previous, next, expected) => {
    expect(replaceNickname(text, previous, next)).toBe(expected);
  });
});
