import { openTree, type PersonNameRow } from '@open-ancestry/db';
import { importGedcom } from '@open-ancestry/import';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nameRow } from './edits';
import { createTestTree, testApi, type TestApi } from './test/helpers';

const existing = (full_text: string, nickname: string | null): PersonNameRow =>
  ({
    id: 'n1',
    person_id: 'p1',
    type: 'birth',
    given: 'Ann',
    surname: 'Ash',
    surname_prefix: null,
    prefix: null,
    suffix: null,
    nickname,
    full_text,
    surname_key: null,
    is_primary: 1,
    sort_order: 0,
  }) as PersonNameRow;

describe('nameRow keeps full_text current when the nickname changes', () => {
  it.each([
    ['Ann "Nan" /Ash/', 'Tad', 'Ann "Tad" /Ash/'],
    ['Ann “Nan” /Ash/', 'Tad', 'Ann “Tad” /Ash/'],
    ['Ann (Nan) /Ash/', 'Tad', 'Ann (Tad) /Ash/'],
    ['Ann (Nan) /Ash/', null, 'Ann /Ash/'],
    ['Ann "Nan" /Ash/', null, 'Ann /Ash/'],
  ])('%j with nickname %j saves %j', (text, nickname, saved) => {
    expect(nameRow({ nickname }, existing(text, 'Nan')).full_text).toBe(saved);
  });

  it('leaves a text that never spelled out the nickname alone', () => {
    expect(nameRow({ nickname: 'Tad' }, existing('Ann /Ash/', null)).full_text).toBeUndefined();
  });
});

describe('editing an imported nickname through the API', () => {
  let api: TestApi;
  beforeEach(async () => {
    api = await testApi();
  });
  afterEach(() => api.close());

  it('updates the stored name text, so the person page and export agree', async () => {
    const base = await createTestTree(api, 'Imported');
    const store = openTree(join(api.root, 'Imported.oatree'));
    await importGedcom(
      {
        bytes: [
          '0 HEAD',
          '1 GEDC',
          '2 VERS 5.5.1',
          '0 @I1@ INDI',
          '1 NAME Ann (Nan) /Ash/',
          '2 NICK Nan',
          '0 TRLR',
          '',
        ].join('\n'),
      },
      store,
    );
    const name = store.db.prepare('SELECT id, person_id FROM person_name').get() as {
      id: string;
      person_id: string;
    };
    store.close();
    const res = await api.patch(`${base}/names/${name.id}`, { nickname: 'Tad' });
    expect(res.json().name).toMatchObject({
      nickname: 'Tad',
      full_text: 'Ann (Tad) /Ash/',
      given: 'Ann',
    });
    const detail = (await api.get(`${base}/people/${name.person_id}`)).json();
    expect(JSON.stringify(detail)).not.toContain('Nan');
    const ged = (await api.get(`${base}/export.ged`)).body;
    expect(ged).toContain('1 NAME Ann (Tad) /Ash/');
    expect(ged).not.toContain('Nan');
  });
});
