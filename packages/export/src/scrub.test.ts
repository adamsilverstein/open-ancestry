import { describe, expect, it } from 'vitest';
import { NameScrubber } from './scrub';

/*
 * Review of #212: names the first scrub missed. Each case is text on a
 * deceased relative's record naming a withheld (living) person.
 */
const scrubber = new NameScrubber([
  { given: 'Zedekiah Quillon', surname: 'Livingson', nickname: 'Zeddo', full_text: null },
  { given: 'Li', surname: 'Wu', nickname: null, full_text: null },
  { given: 'Al', surname: 'Ng', nickname: null, full_text: null },
  { given: '明', surname: '李', nickname: null, full_text: null },
  { given: 'Zoë', surname: 'Müller', nickname: null, full_text: null },
  { given: 'Sean', surname: "O'Brien", nickname: null, full_text: null },
]);
const text = (value: string) => scrubber.scrub(value, 'text');
const file = (value: string) => scrubber.scrub(value, 'file');

describe('NameScrubber', () => {
  it('replaces whole words of 3+ letters, keeping the rest', () => {
    expect(text('Witnessed by Zedekiah Livingson.')).toBe('Witnessed by Private Private.');
    expect(text('Zeddo, the grandson')).toBe('Private, the grandson');
    expect(text("O'Brien and O’Brien")).not.toMatch(/Brien/);
    // A short word on its own is too common to remove ("al", "li").
    expect(text('Al fresco, li-ion')).toBe('Al fresco, li-ion');
  });

  it('replaces a short name as a full given + surname phrase, either order', () => {
    expect(text('Photo of Li Wu at school')).toBe('Photo of Private at school');
    expect(text('WU Li and Al Ng')).toBe('Private and Private');
  });

  it('replaces names in scripts without spaces as substrings', () => {
    expect(text('李明的照片')).toBe('Private的照片');
    expect(text('李明结婚')).toBe('Private结婚');
  });

  it('matches text typed without accents', () => {
    expect(text('Zoe Muller visited')).toBe('Private Private visited');
    expect(text('ZOË MÜLLER')).toBe('Private Private');
  });

  it('splits words glued to digits or run together in camel case', () => {
    expect(text('zedekiah2015 and ZedekiahLivingson')).toBe('Private2015 and PrivatePrivate');
    expect(text('see %20Livingson')).toBe('see %20Private');
  });

  it('matches names inside file names and URLs as substrings, after percent-decoding', () => {
    expect(file('photos/zedekiah2015.jpg')).toBe('photos/Private2015.jpg');
    expect(file('https://facebook.com/zedekiahlivingson')).toBe(
      'https://facebook.com/PrivatePrivate',
    );
    expect(file('https://x.org/Zedekiah%20Livingson.jpg')).toBe(
      'https://x.org/Private%20Private.jpg',
    );
    expect(file('m/liwu.jpg')).toBe('m/Private.jpg');
  });

  it('treats links and e-mail addresses inside prose like file names (#212 review)', () => {
    expect(text('Found him at facebook.com/zedekiahlivingson today')).toBe(
      'Found him at facebook.com/PrivatePrivate today',
    );
    expect(text('Write to zedlivingson@gmail.com or https://x.org/zedekiah2015.')).toBe(
      'Write to zedPrivate@gmail.com or https://x.org/Private2015.',
    );
    // The rest of the sentence keeps the text-mode rules: no substrings in ordinary words.
    expect(text('Livingstone visited')).toBe('Livingstone visited');
  });

  it('replaces names in an encoded link without decoding anything else', () => {
    expect(file('https://x.org/a%26b/Zedekiah%20Livingson.jpg?q=%2F')).toBe(
      'https://x.org/a%26b/Private%20Private.jpg?q=%2F',
    );
    expect(file('https://x.org/%E6%9D%8E%E6%98%8E.png')).toBe('https://x.org/Private.png');
  });

  // Security review of #212.
  it('decodes every layer of percent-encoding before matching', () => {
    // %255A is %5A encoded again, which is Z: a reader that decodes twice sees the name.
    expect(file('https://x.org/%255Aedekiah.jpg')).not.toMatch(/edekiah/i);
    expect(file('https://x.org/Zedekiah%2520Livingson')).toBe('https://x.org/Private%2520Private');
    expect(text('see x.org/%25255Aedekiah')).not.toMatch(/edekiah/i);
  });

  it('matches compatibility and case variants of a name (fullwidth, ligatures, ß)', () => {
    expect(text('Ｚｅｄｅｋｉａｈ ＬＩＶＩＮＧＳＯＮ')).toBe('Private Private');
    expect(text('Ze\u0301dekiah')).not.toMatch(/dekiah/);
    const strauss = new NameScrubber([
      { given: 'Effie', surname: 'Strauß', nickname: null, full_text: null },
    ]);
    expect(strauss.scrub('Letter from STRAUSS and E\uFB00ie', 'text')).toBe(
      'Letter from Private and Private',
    );
  });

  it('scrubs a long adversarial note in linear time', () => {
    const notes = [
      'a-'.repeat(100_000),
      'a'.repeat(200_000),
      'a.'.repeat(100_000),
      'x@'.repeat(100_000),
      `${'a.'.repeat(50_000)}/zedekiah`,
      `${'.'.repeat(200_000)}x`,
      `a.${'b'.repeat(200_000)}`,
    ];
    for (const note of notes) {
      const start = performance.now();
      text(note);
      expect(performance.now() - start, note.slice(0, 8)).toBeLessThan(1000);
    }
  });

  // Security re-review of #212.
  it('splits camel case in one pass, however many combining marks a word carries', () => {
    const notes = [
      `a${'\u0301'.repeat(20_000)}B`,
      'aB'.repeat(25_000),
      `${'a\u0301'.repeat(25_000)}Zedekiah`,
    ];
    for (const note of notes) {
      const start = performance.now();
      text(note);
      expect(performance.now() - start).toBeLessThan(500);
    }
    expect(text('ZedekiahLivingson')).toBe('PrivatePrivate');
  });

  it('ignores invisible format characters inside a name', () => {
    expect(text('Zede\u00ADkiah, Zede\u200Bkiah and Zede\u200Dkiah')).toBe(
      'Private, Private and Private',
    );
  });

  it('decodes HTML entities before matching', () => {
    expect(text('Zo&euml; M&uuml;ller')).toBe('Private Private');
    expect(text('&#90;edekiah and &#x5A;edekiah &amp; co')).toBe('Private and Private &amp; co');
  });

  it('treats a bare domain in prose as a link', () => {
    expect(text('See zedekiahlivingson.com.')).toBe('See PrivatePrivate.com.');
    expect(text('e.g. Mr. Lee')).toBe('e.g. Mr. Lee');
  });

  it('scrubs thousands of file paths quickly with tens of thousands of withheld people', () => {
    const syllables = ['ka', 'lo', 'mi', 'ren', 'sa', 'tu', 'vel', 'dor', 'an', 'is'];
    // 27k distinct five-syllable names (given and surname), like a large real tree.
    const word = (n: number) =>
      [0, 1, 2, 3, 4].map((k) => syllables[Math.floor(n / 10 ** k) % 10]).join('');
    const many = new NameScrubber(
      Array.from({ length: 27_000 }, (_, i) => ({
        given: word(i),
        surname: word(99_999 - i),
        nickname: null,
        full_text: null,
      })),
    );
    const start = performance.now();
    for (let i = 0; i < 15_000; i++) {
      many.scrub(`photos/Family reunion ${i}/IMG_${i}_${word(30_000 + i)}_portrait.jpg`, 'file');
    }
    expect(performance.now() - start).toBeLessThan(3000);
    const out = many.scrub(`photos/${word(5)}${word(99_999 - 12)}.jpg`, 'file');
    expect(out).not.toContain(word(5));
    expect(out).not.toContain(word(99_999 - 12));
  });

  it('leaves text without withheld names untouched', () => {
    expect(text('Born at Rose Hill in 1850')).toBe('Born at Rose Hill in 1850');
    expect(new NameScrubber([]).scrub('Zedekiah', 'text')).toBe('Zedekiah');
  });
});
