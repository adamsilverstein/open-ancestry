import { openMemoryTree, type TreeStore } from '@open-ancestry/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { importGedcom } from '../import';
import { FIXTURES, TODAY, pid, value } from '../test-helpers';
import { applyReimport, closeReimport, prepareReimport, type ReimportSession } from './index';

const SAMPLE = readFileSync(join(FIXTURES, 'ancestry-sample.ged'), 'utf8').replace(/^\uFEFF/, '');
const renumber = (text: string, offset = 100) =>
  text.replace(/@([A-Z]+)(\d+)@/g, (_, p: string, n: string) => `@${p}${Number(n) + offset}@`);
const recordOf = (text: string, xref: string) => {
  const all = text.split('\n');
  const start = all.findIndex((l) => l.startsWith(`0 ${xref} `));
  let end = start + 1;
  while (end < all.length && !all[end]!.startsWith('0 ')) end++;
  return { all, start, end };
};
/** Appends lines to one record. */
const append = (text: string, xref: string, lines: string[]) => {
  const { all, end } = recordOf(text, xref);
  all.splice(end, 0, ...lines);
  return all.join('\n');
};

let store: TreeStore;
beforeEach(async () => {
  store = openMemoryTree();
  await importGedcom({ bytes: SAMPLE }, store, { today: TODAY });
});
const changesOf = (s: ReimportSession, xref: string) =>
  s.diff.people.filter((p) => p.existingId === pid(store, xref)).flatMap((p) => p.changes);
const defaults = (s: ReimportSession) =>
  new Set(
    s.diff.people
      .flatMap((p) => p.changes)
      .filter((c) => c.defaultAccept)
      .map((c) => c.id),
  );

describe('declined additions on re-import (#271)', () => {
  it('does not re-offer a declined new fact, ticked, for the same export', async () => {
    const withResi = append(SAMPLE, '@I3@', ['1 RESI', '2 DATE 1910', '2 PLAC Dalesend, Wexmoor']);
    const first = await prepareReimport(store, { bytes: renumber(withResi) }, { today: TODAY });
    expect(changesOf(first, '@I3@').map((c) => c.kind)).toEqual(['fact.add']);
    applyReimport(store, first, new Set(), 'Re-import, declined');
    closeReimport(first);
    const again = await prepareReimport(
      store,
      { bytes: renumber(withResi, 200) },
      { today: TODAY },
    );
    try {
      // Declined last time and the export has not changed: like a declined fact.change (P6),
      // it should not come back pre-ticked for "Apply" to re-add.
      const adds = changesOf(again, '@I3@').filter((c) => c.kind === 'fact.add');
      expect(adds.filter((c) => c.defaultAccept)).toEqual([]);
    } finally {
      closeReimport(again);
    }
  });

  it('does not re-offer a declined citation, ticked, for the same export', async () => {
    const withCite = append(SAMPLE, '@I3@', [
      '1 SOUR @S1@',
      '2 PAGE Year: 1910; Census Place: Dalesend',
    ]);
    const first = await prepareReimport(store, { bytes: renumber(withCite) }, { today: TODAY });
    expect(changesOf(first, '@I3@').map((c) => c.kind)).toEqual(['citation.add']);
    applyReimport(store, first, new Set(), 'Re-import, declined');
    closeReimport(first);
    const again = await prepareReimport(
      store,
      { bytes: renumber(withCite, 200) },
      { today: TODAY },
    );
    try {
      const adds = changesOf(again, '@I3@').filter((c) => c.kind === 'citation.add');
      expect(adds.filter((c) => c.defaultAccept)).toEqual([]);
    } finally {
      closeReimport(again);
    }
  });
});

describe('tags the user removed (#271)', () => {
  it('does not offer back a tag the user removed when the export still has it', async () => {
    const thaddeus = pid(store, '@I1@');
    const link = value<string>(
      store,
      "SELECT id FROM tag_link WHERE owner_type = 'person' AND owner_id = ?",
      thaddeus,
    );
    store.transact('Remove tag', (tx) => tx.delete('tag_link', link));
    const s = await prepareReimport(store, { bytes: renumber(SAMPLE) }, { today: TODAY });
    try {
      // Removed citations, media, names and facts are held (#224); tags are not.
      expect(changesOf(s, '@I1@').filter((c) => c.kind === 'tag.add')).toEqual([]);
    } finally {
      closeReimport(s);
    }
  });
});

describe('places in re-imported facts (#271)', () => {
  const elderford = () =>
    value<string>(
      store,
      "SELECT id FROM place WHERE full_name = 'Elderford, Cask County, Ohio, USA'",
    );

  it('adds a new fact at a place the user renamed to the renamed place, not a re-created copy', async () => {
    const place = elderford();
    store.transact('Rename place', (tx) =>
      tx.update('place', place, { full_name: 'Elderford, Ohio' } as never),
    );
    const withResi = append(SAMPLE, '@I3@', [
      '1 RESI',
      '2 DATE 1910',
      '2 PLAC Elderford, Cask County, Ohio, USA',
    ]);
    const s = await prepareReimport(store, { bytes: renumber(withResi) }, { today: TODAY });
    try {
      expect(changesOf(s, '@I3@').map((c) => c.kind)).toEqual(['fact.add']);
      applyReimport(store, s, defaults(s), 'Re-import');
    } finally {
      closeReimport(s);
    }
    // The old name comes back as a second place row; the user's rename is undone for this fact.
    expect(value(store, "SELECT count(*) FROM place WHERE full_name LIKE 'Elderford, Cask%'")).toBe(
      0,
    );
  });

  it('reuses a place whose name differs only in case, as the diff treats it as the same', async () => {
    const withResi = append(SAMPLE, '@I3@', [
      '1 RESI',
      '2 DATE 1910',
      '2 PLAC ELDERFORD, CASK COUNTY, OHIO, USA',
    ]);
    const s = await prepareReimport(store, { bytes: renumber(withResi) }, { today: TODAY });
    try {
      applyReimport(store, s, defaults(s), 'Re-import');
    } finally {
      closeReimport(s);
    }
    expect(
      value(
        store,
        "SELECT count(*) FROM place WHERE lower(full_name) = 'elderford, cask county, ohio, usa'",
      ),
    ).toBe(1);
  });
});

describe('a declined new person (#271)', () => {
  it('does not re-offer a declined new child, ticked, for the same export', async () => {
    const withNoah = (offset: number) =>
      renumber(
        append(
          SAMPLE.replace(
            '0 @F1@ FAM',
            [
              '0 @I27@ INDI',
              '1 NAME Noah /Ashgrove/',
              '1 SEX M',
              '1 BIRT',
              '2 DATE 1992',
              '1 FAMC @F9@',
              '0 @F1@ FAM',
            ].join('\n'),
          ),
          '@F9@',
          ['1 CHIL @I27@'],
        ),
        offset,
      );
    const first = await prepareReimport(store, { bytes: withNoah(100) }, { today: TODAY });
    const noah = (s: ReimportSession) => s.diff.people.find((p) => p.name === 'Noah Ashgrove');
    expect(noah(first)?.changes.find((c) => c.kind === 'person.new')?.defaultAccept).toBe(true);
    applyReimport(store, first, new Set(), 'Re-import, Noah declined');
    closeReimport(first);
    const again = await prepareReimport(store, { bytes: withNoah(200) }, { today: TODAY });
    try {
      expect(noah(again)?.changes.find((c) => c.kind === 'person.new')?.defaultAccept).not.toBe(
        true,
      );
    } finally {
      closeReimport(again);
    }
  });
});
