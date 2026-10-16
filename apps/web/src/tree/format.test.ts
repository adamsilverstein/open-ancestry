import { describe, expect, it } from 'vitest';
import { lifeEvent, toPersonSummary } from './format';
import type { ApiPersonSummary } from './api';

const base: ApiPersonSummary = {
  id: 'p1',
  sex: 'F',
  living: 'dead',
  privacy: 'public',
  primaryMediaId: null,
  primaryPhotoLocal: false,
  primaryPhotoVersion: null,
  given: 'Ada',
  surname: 'Vale',
  surnamePrefix: null,
  prefix: null,
  suffix: null,
  nickname: null,
  birth: {
    eventId: 'e1',
    type: 'BIRT',
    dateText: 'ABT 1911',
    dateQualifier: 'abt',
    dateSort: 19110000,
    place: 'Wexmoor, Westmere',
  },
  death: {
    eventId: 'e2',
    type: 'DEAT',
    dateText: '5 SEP 1957',
    dateQualifier: 'exact',
    dateSort: 19570905,
    place: null,
  },
};

describe('toPersonSummary', () => {
  it('maps a database summary to what cards show', () => {
    expect(toPersonSummary(base, 'tree')).toEqual({
      id: 'p1',
      name: 'Ada Vale',
      // The stored parts, which the fan fits labels from.
      given: 'Ada',
      surname: 'Vale',
      sex: 'F',
      birth: { year: 1911, qualifier: 'abt' },
      death: { year: 1957 },
      living: false,
      photoUrl: undefined,
    });
  });

  it('treats inferred living people as living and X as unknown sex', () => {
    const s = toPersonSummary(
      { ...base, sex: 'X', living: 'inferred_living', death: null, given: null, surname: null },
      'tree',
    );
    expect(s.living).toBe(true);
    expect(s.sex).toBe('U');
    expect(s.name).toBe('Unknown');
    expect(s.given).toBeUndefined();
    expect(s.surname).toBeUndefined();
  });

  it('keeps a surname prefix with the surname', () => {
    const s = toPersonSummary(
      { ...base, given: 'Maria', surnamePrefix: 'van', surname: 'Hoek' },
      't',
    );
    expect(s.surname).toBe('van Hoek');
  });

  it('uses the small thumbnail of a local primary photo, and nothing otherwise', () => {
    const local = { ...base, primaryMediaId: 'm1', primaryPhotoLocal: true };
    expect(toPersonSummary(local, 'my tree').photoUrl).toBe(
      '/api/trees/my%20tree/media/m1/thumb/sm',
    );
    const remote = { ...base, primaryMediaId: 'm1', primaryPhotoLocal: false };
    expect(toPersonSummary(remote, 'my tree').photoUrl).toBeUndefined();
  });
});

describe('lifeEvent', () => {
  it('formats the date for display with the place', () => {
    expect(lifeEvent(base.death)).toEqual({ date: '5 Sep 1957', place: undefined });
    expect(lifeEvent(base.birth)?.date).toMatch(/^abt\. 1911$/);
    expect(lifeEvent(base.birth)?.place).toBe('Wexmoor, Westmere');
    expect(lifeEvent(null)).toBeUndefined();
  });
});
