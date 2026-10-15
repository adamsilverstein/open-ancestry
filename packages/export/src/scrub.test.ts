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

  it('leaves text without withheld names untouched', () => {
    expect(text('Born at Rose Hill in 1850')).toBe('Born at Rose Hill in 1850');
    expect(new NameScrubber([]).scrub('Zedekiah', 'text')).toBe('Zedekiah');
  });
});
