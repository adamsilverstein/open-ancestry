import { describe, expect, it } from 'vitest';
import {
  citationsOf,
  familyEvents,
  fid,
  ged,
  importInto,
  notesOf,
  personEvents,
  pid,
  row,
  rows,
  tagsOf,
  value,
} from './test-helpers';

const codes = (warnings: { code: string }[]) => warnings.map((w) => w.code);

describe('names', () => {
  it('reads a parenthesized nickname that NICK confirms as the nickname', async () => {
    const { store } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 NAME Ann (Nan) /Ash/',
        '2 NICK Nan',
        '0 @I2@ INDI',
        '1 NAME John (Jr) /Ash/',
        '0 @I3@ INDI',
        '1 NAME Bo (Big "J") /Ash/',
        '2 NICK Big "J"',
      ),
    );
    expect(
      rows(store, 'SELECT given, nickname, full_text FROM person_name ORDER BY full_text'),
    ).toEqual([
      { given: 'Ann', nickname: 'Nan', full_text: 'Ann (Nan) /Ash/' },
      { given: 'Bo', nickname: 'Big "J"', full_text: 'Bo (Big "J") /Ash/' },
      { given: 'John (Jr)', nickname: null, full_text: 'John (Jr) /Ash/' },
    ]);
  });

  it('maps TYPE, NPFX, NSFX, NICK, SPFX and _MARNM variants', async () => {
    const { store, report } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 NAME Rev. Ellis "Eli" /van Vale/ Jr.',
        '2 NPFX Rev.',
        '2 GIVN Ellis',
        '2 NICK Eli',
        '2 SPFX van',
        '2 SURN Vale',
        '2 NSFX Jr.',
        '2 _MARNM Fenn',
        '2 NOTE Spelled Vail in the 1880 census',
        '2 SOUR @S1@',
        '3 PAGE p. 4',
        '1 NAME Ellis /Vail/',
        '2 TYPE aka',
        '1 NAME Brother Ellis',
        '2 TYPE religious',
        '1 NAME Ellis /Oddtype/',
        '2 TYPE somethingelse',
        '0 @S1@ SOUR',
        '1 TITL Register',
      ),
    );
    const names = rows(
      store,
      `SELECT type, prefix, given, nickname, surname_prefix, surname, suffix, full_text, is_primary, sort_order
       FROM person_name ORDER BY sort_order`,
    );
    expect(names).toEqual([
      {
        type: 'birth',
        prefix: 'Rev.',
        given: 'Ellis',
        nickname: 'Eli',
        surname_prefix: 'van',
        surname: 'Vale',
        suffix: 'Jr.',
        full_text: 'Rev. Ellis "Eli" /van Vale/ Jr.',
        is_primary: 1,
        sort_order: 0,
      },
      {
        type: 'married',
        prefix: null,
        given: 'Ellis',
        nickname: null,
        surname_prefix: null,
        surname: 'Fenn',
        suffix: null,
        full_text: 'Ellis /Fenn/',
        is_primary: 0,
        sort_order: 1,
      },
      expect.objectContaining({ type: 'aka', surname: 'Vail', sort_order: 2 }),
      expect.objectContaining({ type: 'religious', given: 'Brother', surname: 'Ellis' }),
      expect.objectContaining({ type: 'other', surname: 'Oddtype' }),
    ]);
    const primary = value<string>(store, 'SELECT id FROM person_name WHERE sort_order = 0');
    expect(notesOf(store, 'person_name', primary)).toEqual(['Spelled Vail in the 1880 census']);
    expect(citationsOf(store, 'person_name', primary)[0]).toMatchObject({ page: 'p. 4' });
    expect(report.unmapped).toEqual([]);
  });

  it('parses a name without slashes and leaves an empty NAME unmapped', async () => {
    const { store, report } = await importInto(
      ged('0 @I1@ INDI', '1 NAME Ada Lovelace', '1 NAME', '1 SEX f'),
    );
    expect(rows(store, 'SELECT given, surname FROM person_name')).toEqual([
      { given: 'Ada', surname: 'Lovelace' },
    ]);
    expect(value(store, 'SELECT sex FROM person')).toBe('F');
    expect(report.unmapped.map((u) => u.path)).toEqual(['INDI.NAME']);
  });

  it('warns about an unknown SEX value and keeps U', async () => {
    const { store, report } = await importInto(ged('0 @I1@ INDI', '1 SEX Q'));
    expect(value(store, 'SELECT sex FROM person')).toBe('U');
    expect(codes(report.warnings)).toContain('invalid-value');
    expect(report.unmapped.map((u) => u.path)).toEqual(['INDI.SEX']);
  });
});

describe('events', () => {
  it('keeps alternate facts: the first BIRT is preferred, later ones are alternates', async () => {
    const { store } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 BIRT',
        '2 DATE 1850',
        '1 BIRT',
        '2 DATE 1851',
        '1 RESI',
        '2 DATE 1860',
        '1 RESI',
        '2 DATE 1870',
      ),
    );
    expect(
      personEvents(store, '@I1@').map((e) => [e.type, e.date_text, e.is_preferred, e.sort_order]),
    ).toEqual([
      ['BIRT', '1850', 1, 0],
      ['BIRT', '1851', 0, 1],
      ['RESI', '1860', 1, 2],
      ['RESI', '1870', 1, 3],
    ]);
  });

  it('maps AGE, CAUS, ADDR, RESN, FACT/TYPE, values and FTM custom events', async () => {
    const { store, report } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 DEAT Y',
        '2 AGE 72y',
        '2 CAUS Pneumonia',
        '2 RESN confidential',
        '1 RESI',
        '2 ADDR 12 Mill Lane',
        '3 CONT Brackenford',
        '3 CITY Brackenford',
        '1 FACT Blue',
        '2 TYPE Eye colour',
        '1 _DNA Haplogroup R1b',
        '1 _FUN',
        '2 DATE 3 MAR 1901',
        '1 _CUSTOMEVT',
        '2 PLAC Brackenford',
        '1 _NOTANEVENT whatever',
      ),
    );
    const events = personEvents(store, '@I1@');
    expect(events.map((e) => e.type)).toEqual([
      'DEAT',
      'RESI',
      'FACT',
      '_DNA',
      '_FUN',
      '_CUSTOMEVT',
    ]);
    expect(events[0]).toMatchObject({
      value: 'Y',
      age: '72y',
      cause: 'Pneumonia',
      privacy: 'confidential',
    });
    expect(events[1]!.description).toBe('12 Mill Lane\nBrackenford');
    expect(events[2]).toMatchObject({ value: 'Blue', custom_type: 'Eye colour' });
    expect(events[3]).toMatchObject({ value: 'Haplogroup R1b' });
    expect(events[5]!.place).toBe('Brackenford');
    expect(report.unmapped.map((u) => u.path).sort()).toEqual(['INDI._NOTANEVENT']);
  });

  it('stores unparseable dates as text and leaves empty DATE lines unmapped', async () => {
    const { store, report } = await importInto(
      ged('0 @I1@ INDI', '1 BIRT', '2 DATE sometime in spring', '1 DEAT', '2 DATE'),
    );
    expect(personEvents(store, '@I1@', 'BIRT')[0]).toMatchObject({
      date_text: 'sometime in spring',
      date_qualifier: 'text',
      date_sort: null,
    });
    expect(report.unmapped.map((u) => u.path)).toEqual(['INDI.DEAT.DATE']);
  });

  it('maps family events, NCHI and _STAT relationship', async () => {
    const { store } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 FAMS @F1@',
        '0 @I2@ INDI',
        '1 FAMS @F1@',
        '0 @F1@ FAM',
        '1 HUSB @I1@',
        '1 WIFE @I2@',
        '1 _STAT Partners',
        '1 ENGA',
        '2 DATE 1900',
        '1 DIV',
        '2 DATE 1910',
        '1 NCHI 0',
        '1 RESN locked',
      ),
    );
    expect(familyEvents(store, '@F1@').map((e) => [e.type, e.value])).toEqual([
      ['ENGA', null],
      ['DIV', null],
      ['NCHI', '0'],
    ]);
    expect(row(store, 'SELECT relationship_type, privacy FROM family')).toEqual({
      relationship_type: 'partners',
      privacy: 'locked',
    });
  });

  it('turns an INDI MARR without a matching FAM marriage into the family marriage', async () => {
    const { store } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 FAMS @F1@',
        '1 MARR',
        '2 DATE 1890',
        '2 SOUR @S1@',
        '0 @I2@ INDI',
        '1 FAMS @F1@',
        '0 @F1@ FAM',
        '1 HUSB @I1@',
        '1 WIFE @I2@',
        '0 @S1@ SOUR',
        '1 TITL Parish register',
      ),
    );
    expect(personEvents(store, '@I1@', 'MARR')).toEqual([]);
    const [marr] = familyEvents(store, '@F1@', 'MARR');
    expect(marr).toMatchObject({ date_text: '1890' });
    expect(citationsOf(store, 'event', marr!.id)).toHaveLength(1);
    expect(value(store, 'SELECT relationship_type FROM family')).toBe('married');
  });

  it('keeps an INDI MARR as a personal event when it matches no family', async () => {
    const { store } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 FAMS @F1@',
        '1 FAMS @F2@',
        '1 MARR',
        '2 DATE 1890',
        '0 @F1@ FAM',
        '1 HUSB @I1@',
        '0 @F2@ FAM',
        '1 HUSB @I1@',
      ),
    );
    expect(personEvents(store, '@I1@', 'MARR')).toHaveLength(1);
  });
});

describe('places', () => {
  it('maps MAP coordinates, skips empty jurisdictions and rejects out-of-range values', async () => {
    const { store, report } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 BIRT',
        '2 PLAC , Brackenford, , Wexmoor',
        '3 MAP',
        '4 LATI N51.5',
        '4 LONG W0.25',
        '1 DEAT',
        '2 PLAC Nowhere',
        '3 MAP',
        '4 LATI 95',
        '4 LONG -200',
        '1 BURI',
        '2 PLAC Brackenford, Wexmoor',
        '3 NOTE Old churchyard',
      ),
    );
    expect(
      row(
        store,
        "SELECT name, latitude, longitude FROM place WHERE full_name = 'Brackenford, Wexmoor'",
      ),
    ).toEqual({ name: 'Brackenford', latitude: 51.5, longitude: -0.25 });
    expect(value(store, 'SELECT count(*) FROM place')).toBe(3);
    expect(row(store, "SELECT latitude, longitude FROM place WHERE name = 'Nowhere'")).toEqual({
      latitude: null,
      longitude: null,
    });
    expect(codes(report.warnings).filter((c) => c === 'invalid-value')).toHaveLength(2);
    const place = value<string>(
      store,
      "SELECT id FROM place WHERE full_name = 'Brackenford, Wexmoor'",
    );
    expect(notesOf(store, 'place', place)).toEqual(['Old churchyard']);
  });
});

describe('sources, citations, repositories and notes', () => {
  it('maps citation QUAY, DATA DATE/TEXT, notes and deduplicates identical citations', async () => {
    const { store, report } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 SOUR @S1@',
        '2 PAGE Folio 3',
        '2 QUAY 2',
        '2 DATA',
        '3 DATE 1 JAN 1900',
        '3 TEXT Baptised this day',
        '4 CONC  in the parish',
        '2 NOTE Transcribed by hand',
        '1 BIRT',
        '2 SOUR @S1@',
        '3 PAGE Folio 9',
        '1 DEAT',
        '2 SOUR @S1@',
        '3 PAGE Folio 9',
        '2 SOUR @S1@',
        '3 QUAY 9',
        '1 NOTE @N1@',
        '1 SOUR Family Bible of the Vale family',
        '0 @S1@ SOUR',
        '1 TITL Parish register',
        '1 ABBR PR',
        '1 TEXT Entries 1850-1900',
        '1 REPO @R1@',
        '2 CALN MS 42',
        '1 NOTE Microfilm copy',
        '0 @R1@ REPO',
        '1 NAME County Archive',
        '1 ADDR 1 High St',
        '2 CITY Wexmoor',
        '1 WWW https://archive.example',
        '1 EMAIL a@@archive.example',
        '1 PHON 555-0100',
        '0 @N1@ NOTE A shared note',
        '1 CONT on two lines',
      ),
    );
    const person = pid(store, '@I1@');
    const [c] = citationsOf(store, 'person', person);
    expect(c).toMatchObject({
      page: 'Folio 3',
      quality: 2,
      date_text: '1 JAN 1900',
      text: 'Baptised this day in the parish',
    });
    const citationId = value<string>(store, "SELECT id FROM citation WHERE page = 'Folio 3'");
    expect(notesOf(store, 'citation', citationId)).toEqual(['Transcribed by hand']);
    // BIRT and DEAT cite the same page: one citation row, two links.
    expect(value(store, "SELECT count(*) FROM citation WHERE page = 'Folio 9'")).toBe(1);
    expect(value(store, 'SELECT count(*) FROM citation_link')).toBe(5);
    expect(codes(report.warnings)).toContain('invalid-value');
    expect(notesOf(store, 'person', person)).toEqual(['A shared note\non two lines']);
    expect(row(store, 'SELECT title, text FROM source WHERE external_id IS NULL')).toEqual({
      title: 'Family Bible of the Vale family',
      text: 'Family Bible of the Vale family',
    });
    expect(
      row(store, "SELECT abbreviation, text, call_number FROM source WHERE external_id = '@S1@'"),
    ).toEqual({ abbreviation: 'PR', text: 'Entries 1850-1900', call_number: 'MS 42' });
    expect(
      notesOf(store, 'source', value(store, "SELECT id FROM source WHERE external_id = '@S1@'")),
    ).toEqual(['Microfilm copy']);
    expect(row(store, 'SELECT name, address, url, email, phone FROM repository')).toEqual({
      name: 'County Archive',
      address: '1 High St\nWexmoor',
      url: 'https://archive.example',
      email: 'a@archive.example',
      phone: '555-0100',
    });
    expect(report.unmapped.map((u) => u.path)).toEqual(['INDI.DEAT.SOUR.QUAY']);
  });

  it('maps GEDCOM 7 SNOTE records and pointers', async () => {
    const text = [
      '0 HEAD',
      '1 GEDC',
      '2 VERS 7.0',
      '0 @N1@ SNOTE Shared in v7',
      '0 @I1@ INDI',
      '1 SNOTE @N1@',
      '1 FAMC @F1@',
      '2 PEDI FOSTER',
      '0 @F1@ FAM',
      '1 CHIL @I1@',
      '0 TRLR',
      '',
    ].join('\n');
    const { store } = await importInto(text);
    expect(notesOf(store, 'person', pid(store, '@I1@'))).toEqual(['Shared in v7']);
    expect(row(store, 'SELECT partner1_rel, partner2_rel FROM family_child')).toEqual({
      partner1_rel: 'foster',
      partner2_rel: 'foster',
    });
  });
});

describe('families and links', () => {
  it('repairs one-sided links and warns', async () => {
    const { store, report } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 SEX M',
        '1 FAMS @F1@',
        '0 @I2@ INDI',
        '1 FAMC @F1@',
        '0 @I3@ INDI',
        '0 @F1@ FAM',
        '1 CHIL @I3@',
        '1 CHIL @I3@',
      ),
    );
    expect(value(store, 'SELECT partner1_id FROM family')).toBe(pid(store, '@I1@'));
    expect(
      rows<{ external_id: string; sort_order: number }>(
        store,
        `SELECT p.external_id, c.sort_order FROM family_child c JOIN person p ON p.id = c.child_id
         ORDER BY c.sort_order`,
      ),
    ).toEqual([
      { external_id: '@I3@', sort_order: 0 },
      { external_id: '@I2@', sort_order: 1 },
    ]);
    expect(codes(report.warnings).filter((c) => c === 'one-sided-link')).toHaveLength(2);
    expect(codes(report.warnings)).toContain('duplicate-link');
  });

  it('warns on bad and wrong-type pointers without throwing', async () => {
    const { store, report } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 FAMC @F99@',
        '1 FAMS @S1@',
        '1 OBJE @O9@',
        '1 _MTTAG @I1@',
        '1 SOUR @R1@',
        '0 @S1@ SOUR',
        '1 TITL A source',
        '1 REPO @NOPE@',
        '0 @R1@ REPO',
        '1 NAME Archive',
        '0 @F1@ FAM',
        '1 HUSB @S1@',
        '1 CHIL @I404@',
      ),
    );
    expect(value(store, 'SELECT count(*) FROM person')).toBe(1);
    const c = codes(report.warnings);
    expect(c.filter((x) => x === 'bad-pointer').length).toBe(4);
    expect(c.filter((x) => x === 'wrong-pointer-type').length).toBe(4);
    expect(report.warnings.every((w) => w.line > 0)).toBe(true);
    expect(report.lines.mapped + report.lines.preserved).toBe(report.lines.total);
  });

  it('refuses a person as their own spouse or parent, and warns on ancestry cycles', async () => {
    const { store, report } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 FAMS @F1@',
        '1 FAMC @F1@',
        '0 @I2@ INDI',
        '1 FAMS @F2@',
        '1 FAMC @F3@',
        '0 @I3@ INDI',
        '1 FAMS @F3@',
        '1 FAMC @F2@',
        '0 @F1@ FAM',
        '1 HUSB @I1@',
        '1 WIFE @I1@',
        '1 CHIL @I1@',
        '0 @F2@ FAM',
        '1 HUSB @I2@',
        '1 CHIL @I3@',
        '0 @F3@ FAM',
        '1 HUSB @I3@',
        '1 CHIL @I2@',
      ),
    );
    expect(
      row(store, 'SELECT partner1_id, partner2_id FROM family WHERE external_id = ?', '@F1@'),
    ).toEqual({
      partner1_id: pid(store, '@I1@'),
      partner2_id: null,
    });
    expect(
      value(store, 'SELECT count(*) FROM family_child WHERE family_id = ?', fid(store, '@F1@')),
    ).toBe(0);
    const c = codes(report.warnings);
    expect(c.filter((x) => x === 'self-relationship')).toHaveLength(1);
    expect(c.filter((x) => x === 'duplicate-partner')).toHaveLength(1);
    expect(c).toContain('relationship-cycle');
    expect(value(store, 'SELECT count(*) FROM family_child')).toBe(2);
  });

  it('applies ADOP FAMC to the adoptive parents when no _FREL/_MREL is given', async () => {
    const { store } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 ADOP',
        '2 FAMC @F1@',
        '3 ADOP WIFE',
        '1 FAMC @F1@',
        '0 @F1@ FAM',
        '1 CHIL @I1@',
        '2 _FREL Step',
      ),
    );
    expect(row(store, 'SELECT partner1_rel, partner2_rel FROM family_child')).toEqual({
      partner1_rel: 'step',
      partner2_rel: 'adopted',
    });
  });

  it('applies FAMC notes and citations to the child link', async () => {
    const { store } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 FAMC @F1@',
        '2 PEDI adopted',
        '2 NOTE Raised by an aunt',
        '2 SOUR @S1@',
        '0 @F1@ FAM',
        '1 CHIL @I1@',
        '0 @S1@ SOUR',
        '1 TITL Court record',
      ),
    );
    const link = value<string>(store, 'SELECT id FROM family_child');
    expect(notesOf(store, 'family_child', link)).toEqual(['Raised by an aunt']);
    expect(citationsOf(store, 'family_child', link)).toHaveLength(1);
    expect(value(store, 'SELECT partner1_rel FROM family_child')).toBe('adopted');
  });
});

describe('tags and privacy', () => {
  it('maps tags on families, events, sources and media; RESN on people', async () => {
    const { store } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 RESN privacy',
        '1 BIRT',
        '2 _MTTAG @T1@',
        '1 FAMS @F1@',
        '0 @F1@ FAM',
        '1 HUSB @I1@',
        '1 _MTTAG @T1@',
        '0 @S1@ SOUR',
        '1 TITL A',
        '1 _MTTAG @T1@',
        '0 @O1@ OBJE',
        '1 FILE photo.jpg',
        '1 _MTTAG @T1@',
        '0 @T1@ _MTTAG',
        '1 NAME Verified',
        '0 @T2@ _MTTAG',
        '1 NAME Verified',
      ),
    );
    expect(value(store, 'SELECT privacy FROM person')).toBe('private');
    expect(value(store, 'SELECT count(*) FROM tag')).toBe(1);
    expect(tagsOf(store, 'family', fid(store, '@F1@'))).toEqual(['/Verified']);
    expect(value(store, 'SELECT count(*) FROM tag_link')).toBe(4);
  });
});

describe('home person and living status', () => {
  it('uses a home person pointer in the header when present', async () => {
    const text = ged('0 @I1@ INDI', '0 @I2@ INDI').replace(
      '1 CHAR UTF-8',
      '1 CHAR UTF-8\n1 _HOME @I2@',
    );
    const { store, report } = await importInto(text);
    expect(report.homePersonId).toBe(pid(store, '@I2@'));
    expect(report.homePersonSource).toBe('header');
  });

  it('falls back to the first person when the header pointer is broken, with a warning', async () => {
    const text = ged('0 @I1@ INDI').replace('1 CHAR UTF-8', '1 CHAR UTF-8\n1 _HOME @I9@');
    const { store, report } = await importInto(text);
    expect(report.homePersonId).toBe(pid(store, '@I1@'));
    expect(codes(report.warnings)).toContain('home-person');
  });

  it('has no home person in a file without individuals', async () => {
    const { report } = await importInto(ged('0 @N1@ NOTE hi'));
    expect(report.homePersonId).toBeNull();
    expect(report.homePersonSource).toBeNull();
  });

  it('infers living from relatives when birth is unknown, and death from burial', async () => {
    const { store } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 FAMS @F1@',
        '0 @I2@ INDI',
        '1 BURI',
        '0 @I3@ INDI',
        '1 FAMC @F1@',
        '1 BIRT',
        '2 DATE 1990',
        '0 @I4@ INDI',
        '1 CHR',
        '2 DATE 1800',
        '0 @F1@ FAM',
        '1 HUSB @I1@',
        '1 CHIL @I3@',
      ),
    );
    const living = (x: string) =>
      value(store, 'SELECT living FROM person WHERE id = ?', pid(store, x));
    expect(living('@I1@')).toBe('inferred_living');
    expect(living('@I2@')).toBe('inferred_dead');
    expect(living('@I3@')).toBe('inferred_living');
    expect(living('@I4@')).toBe('inferred_dead');
  });
});

describe('repeated single-valued lines', () => {
  it('keeps every _APID of a citation, one citation row per Ancestry record', async () => {
    const { store, report } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 BIRT',
        '2 SOUR @S1@',
        '3 PAGE Roll 12',
        '3 PAGE Roll 13',
        '3 _APID 1,7602::111',
        '3 _APID 1,8054::222',
        '2 SOUR @S1@',
        '3 PAGE Roll 12',
        '3 _APID 1,7602::111',
        '3 _APID 1,8054::222',
        '0 @S1@ SOUR',
        '1 TITL Census',
      ),
    );
    const birth = personEvents(store, '@I1@', 'BIRT')[0]!;
    expect(citationsOf(store, 'event', birth.id).map((c) => [c.page, c.apid])).toEqual([
      ['Roll 12', '1,7602::111'],
      ['Roll 12', '1,8054::222'],
    ]);
    expect(value(store, 'SELECT count(*) FROM citation')).toBe(2);
    // The second PAGE has nowhere to go: it stays unmapped, so nothing is silently lost.
    expect(report.unmapped).toEqual([
      expect.objectContaining({
        path: 'INDI.BIRT.SOUR.PAGE',
        count: 1,
        example: { line: 9, text: '3 PAGE Roll 13' },
      }),
    ]);
    expect(report.lines.mapped + report.lines.preserved).toBe(report.lines.total);
  });

  it('keeps the first DATE, PLAC and SEX and leaves repeats unmapped', async () => {
    const { store, report } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 SEX F',
        '1 SEX M',
        '1 BIRT',
        '2 DATE 1850',
        '2 DATE 1851',
        '2 PLAC A',
        '2 PLAC B',
      ),
    );
    expect(personEvents(store, '@I1@', 'BIRT')[0]).toMatchObject({ date_text: '1850', place: 'A' });
    expect(value(store, 'SELECT sex FROM person')).toBe('F');
    expect(report.unmapped.map((u) => u.path).sort()).toEqual([
      'INDI.BIRT.DATE',
      'INDI.BIRT.PLAC',
      'INDI.SEX',
    ]);
  });
});

describe('same-sex couples', () => {
  it.each([
    ['HUSB', 'HUSB'],
    ['WIFE', 'WIFE'],
    ['WIFE', 'HUSB'],
  ])('%s + %s fill both partner slots, without FAMS back-links', async (a, b) => {
    const { store, report } = await importInto(
      ged(
        '0 @I1@ INDI',
        '0 @I2@ INDI',
        '0 @F1@ FAM',
        `1 ${a} @I1@`,
        `1 ${b} @I2@`,
        '1 CHIL @I3@',
        '0 @I3@ INDI',
      ),
    );
    const family = row<{ partner1_id: string; partner2_id: string }>(
      store,
      'SELECT partner1_id, partner2_id FROM family',
    )!;
    expect([family.partner1_id, family.partner2_id].sort()).toEqual(
      [pid(store, '@I1@'), pid(store, '@I2@')].sort(),
    );
    expect(report.warnings).toEqual([]);
    expect(report.unmapped).toEqual([]);
  });

  it('keeps FAMS order for both partners of a same-sex couple', async () => {
    const { store, report } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 FAMS @F0@',
        '1 FAMS @F1@',
        '0 @I2@ INDI',
        '1 FAMS @F1@',
        '0 @F0@ FAM',
        '1 HUSB @I1@',
        '0 @F1@ FAM',
        '1 WIFE @I1@',
        '1 WIFE @I2@',
      ),
    );
    expect(
      row(store, "SELECT partner1_order, partner2_order FROM family WHERE external_id = '@F1@'"),
    ).toEqual({
      partner1_order: 0,
      partner2_order: 1,
    });
    expect(report.warnings).toEqual([]);
  });

  it('warns when a family names a third partner or the same partner twice', async () => {
    const { report } = await importInto(
      ged(
        '0 @I1@ INDI',
        '0 @I2@ INDI',
        '0 @I3@ INDI',
        '0 @F1@ FAM',
        '1 HUSB @I1@',
        '1 HUSB @I1@',
        '1 WIFE @I2@',
        '1 WIFE @I3@',
      ),
    );
    expect(codes(report.warnings)).toEqual(['duplicate-partner', 'duplicate-link']);
    expect(report.warnings[0]!.message).toBe(
      '@I1@ is listed twice as a partner of family @F1@; this HUSB line is ignored',
    );
    expect(report.warnings[1]!.message).toBe(
      'Family @F1@ already has two partners; WIFE @I3@ is not added',
    );
    expect(report.unmapped.map((u) => [u.path, u.count])).toEqual([
      ['FAM.HUSB', 1],
      ['FAM.WIFE', 1],
    ]);
  });
});

describe('attachments an owner cannot take', () => {
  it('leaves a SOUR under a SOUR record and an OBJE under an OBJE record unmapped', async () => {
    const { store, report } = await importInto(
      ged(
        '0 @S1@ SOUR',
        '1 TITL Register',
        '1 SOUR @S1@',
        '1 SOUR inline text',
        '0 @O1@ OBJE',
        '1 FILE https://example.com/a.jpg',
        '1 OBJE @O1@',
      ),
    );
    expect(value(store, 'SELECT count(*) FROM citation')).toBe(0);
    expect(value(store, 'SELECT count(*) FROM media_link')).toBe(0);
    expect(report.unmapped.map((u) => [u.path, u.count])).toEqual([
      ['SOUR.SOUR', 2],
      ['OBJE.OBJE', 1],
    ]);
  });
});

describe('split citations', () => {
  it('attach their notes and media to every copy', async () => {
    const { store } = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 BIRT',
        '2 SOUR @S1@',
        '3 PAGE Roll 12',
        '3 _APID 1,7602::111',
        '3 _APID 1,8054::222',
        '3 NOTE Two census images',
        '3 OBJE @O1@',
        '0 @S1@ SOUR',
        '1 TITL Census',
        '0 @O1@ OBJE',
        '1 FILE https://example.com/a.jpg',
      ),
    );
    const citations = rows<{ id: string; apid: string }>(
      store,
      'SELECT id, apid FROM citation ORDER BY apid',
    );
    expect(citations.map((c) => c.apid)).toEqual(['1,7602::111', '1,8054::222']);
    for (const c of citations) {
      expect(notesOf(store, 'citation', c.id)).toEqual(['Two census images']);
      expect(
        value(
          store,
          "SELECT count(*) FROM media_link WHERE owner_type = 'citation' AND owner_id = ?",
          c.id,
        ),
      ).toBe(1);
    }
    expect(value(store, 'SELECT count(*) FROM note')).toBe(1);
    expect(value(store, 'SELECT count(*) FROM media')).toBe(1);
  });
});
