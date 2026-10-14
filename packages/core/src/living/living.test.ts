import { describe, expect, it } from 'vitest';
import { parseDate } from '../dates';
import { inferLiving } from './index';
import type { LivingInput, LivingResult } from './index';

const today = new Date('2026-10-14T12:00:00Z');

describe('inferLiving', () => {
  it.each<[string, LivingInput, Partial<LivingResult>]>([
    ['no data at all', {}, { living: true, reason: 'no-dates', estimated: false }],
    ['born 50 years ago', { birth: '1976' }, { living: true, reason: 'birth-within-threshold', birthYear: 1976 }],
    ['born 99 years ago', { birth: '1927' }, { living: true, reason: 'birth-within-threshold' }],
    ['born exactly 100 years ago', { birth: '1926' }, { living: false, reason: 'birth-beyond-threshold' }],
    ['born 126 years ago', { birth: '5 SEP 1900' }, { living: false, reason: 'birth-beyond-threshold', birthYear: 1900 }],
    ['about 96 years ago', { birth: 'ABT 1930' }, { living: true }],
    ['recent birth with death date', { birth: '1950', death: '2000' }, { living: false, reason: 'death-facts' }],
    ['recent birth with undated death', { birth: '1950', death: '' }, { living: false, reason: 'death-facts' }],
    ['recent birth with death flag', { birth: '1950', hasDeathFacts: true }, { living: false, reason: 'death-facts' }],
    ['recent birth with burial', { birth: '1950', burial: '2000' }, { living: false, reason: 'death-facts' }],
    ['unparseable birth, no relatives', { birth: 'unknown' }, { living: true, reason: 'no-dates' }],
    ['parent born 1890', { parentBirths: ['1890'] }, { living: false, estimated: true, birthYear: 1915 }],
    ['parent born 1950', { parentBirths: ['1950'] }, { living: true, estimated: true, birthYear: 1975 }],
    ['child born 1960', { childBirths: ['1960'] }, { living: true, estimated: true, birthYear: 1935 }],
    ['child born 1900', { childBirths: ['1900'] }, { living: false, estimated: true, birthYear: 1875 }],
    ['spouse born 1920', { spouseBirths: ['1920'] }, { living: false, estimated: true, birthYear: 1920 }],
    ['spouse born 1940', { spouseBirths: [parseDate('1940')] }, { living: true, estimated: true, birthYear: 1940 }],
    [
      'latest estimate wins',
      { parentBirths: ['1890'], childBirths: ['1990'] },
      { living: true, estimated: true, birthYear: 1965 },
    ],
    ['undated relatives', { parentBirths: ['unknown'], childBirths: [] }, { living: true, reason: 'no-dates' }],
    ['own birth beats relatives', { birth: '1890', childBirths: ['1990'] }, { living: false, estimated: false }],
  ])('%s', (_label, input, expected) => {
    expect(inferLiving(input, today)).toMatchObject(expected);
  });

  it('honours a custom threshold', () => {
    expect(inferLiving({ birth: '1920' }, today, 110).living).toBe(true);
    expect(inferLiving({ birth: '1920' }, today, 100).living).toBe(false);
  });

  it('defaults today to the current date', () => {
    expect(inferLiving({ birth: String(new Date().getFullYear() - 1) }).living).toBe(true);
  });
});
