/**
 * ANSEL (ANSI Z39.47) to Unicode, the default GEDCOM 5.x character set.
 *
 * Bytes below 0x80 are ASCII. 0xE0-0xFE are combining diacritics written
 * before the letter they modify; Unicode puts them after, so they are held
 * until the base character arrives. Includes the GEDCOM 5.5 extensions
 * (0xBE, 0xBF, 0xCD, 0xCE, 0xCF) and MARC-8 additions (0xC7, 0xC8).
 */

const SPACING: Record<number, number> = {
  0xa1: 0x0141, // Ł
  0xa2: 0x00d8, // Ø
  0xa3: 0x0110, // Đ
  0xa4: 0x00de, // Þ
  0xa5: 0x00c6, // Æ
  0xa6: 0x0152, // Œ
  0xa7: 0x02b9, // soft sign
  0xa8: 0x00b7, // middle dot
  0xa9: 0x266d, // flat
  0xaa: 0x00ae, // ®
  0xab: 0x00b1, // ±
  0xac: 0x01a0, // Ơ
  0xad: 0x01af, // Ư
  0xae: 0x02bc, // alif
  0xb0: 0x02bb, // ayn
  0xb1: 0x0142, // ł
  0xb2: 0x00f8, // ø
  0xb3: 0x0111, // đ
  0xb4: 0x00fe, // þ
  0xb5: 0x00e6, // æ
  0xb6: 0x0153, // œ
  0xb7: 0x02ba, // hard sign
  0xb8: 0x0131, // dotless i
  0xb9: 0x00a3, // £
  0xba: 0x00f0, // ð
  0xbc: 0x01a1, // ơ
  0xbd: 0x01b0, // ư
  0xbe: 0x25a1, // empty box (GEDCOM)
  0xbf: 0x25a0, // black box (GEDCOM)
  0xc0: 0x00b0, // °
  0xc1: 0x2113, // script l
  0xc2: 0x2117, // sound recording copyright
  0xc3: 0x00a9, // ©
  0xc4: 0x266f, // sharp
  0xc5: 0x00bf, // ¿
  0xc6: 0x00a1, // ¡
  0xc7: 0x00df, // ß (MARC-8)
  0xc8: 0x20ac, // € (MARC-8)
  0xcd: 0x0065, // midline e (GEDCOM)
  0xce: 0x006f, // midline o (GEDCOM)
  0xcf: 0x00df, // ß (GEDCOM)
};

const COMBINING: Record<number, number> = {
  0xe0: 0x0309, // hook above
  0xe1: 0x0300, // grave
  0xe2: 0x0301, // acute
  0xe3: 0x0302, // circumflex
  0xe4: 0x0303, // tilde
  0xe5: 0x0304, // macron
  0xe6: 0x0306, // breve
  0xe7: 0x0307, // dot above
  0xe8: 0x0308, // diaeresis
  0xe9: 0x030c, // caron
  0xea: 0x030a, // ring above
  0xeb: 0xfe20, // ligature left half
  0xec: 0xfe21, // ligature right half
  0xed: 0x0315, // comma above right
  0xee: 0x030b, // double acute
  0xef: 0x0310, // candrabindu
  0xf0: 0x0327, // cedilla
  0xf1: 0x0328, // ogonek
  0xf2: 0x0323, // dot below
  0xf3: 0x0324, // diaeresis below
  0xf4: 0x0325, // ring below
  0xf5: 0x0333, // double low line
  0xf6: 0x0332, // low line
  0xf7: 0x0326, // comma below
  0xf8: 0x031c, // left half ring below
  0xf9: 0x032e, // breve below
  0xfa: 0xfe22, // double tilde left half
  0xfb: 0xfe23, // double tilde right half
  0xfe: 0x0313, // comma above
};

/** Byte -> code point for single characters; -1 for combining marks, 0 for undefined bytes. */
const TABLE = new Int32Array(256);
for (let b = 0; b < 0x80; b++) TABLE[b] = b;
for (const [b, cp] of Object.entries(SPACING)) TABLE[Number(b)] = cp;
for (const b of Object.keys(COMBINING)) TABLE[Number(b)] = -1;

/** Stateful ANSEL decoder; diacritics at the end of a chunk wait for the next one. */
export class AnselDecoder {
  private pending = '';
  invalid = 0;

  decode(bytes: Uint8Array): string {
    let out = '';
    let pending = this.pending;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const cp = TABLE[b]!;
      if (cp === -1) {
        pending += String.fromCharCode(COMBINING[b]!);
        continue;
      }
      let ch: string;
      if (cp === 0 && b !== 0) {
        this.invalid++;
        ch = '\uFFFD';
      } else {
        ch = String.fromCharCode(cp);
      }
      out += ch;
      if (pending) {
        out += pending;
        pending = '';
      }
    }
    this.pending = pending;
    return out.normalize('NFC');
  }

  end(): string {
    const rest = this.pending;
    this.pending = '';
    return rest;
  }
}

export function decodeAnsel(bytes: Uint8Array): { text: string; invalid: number } {
  const decoder = new AnselDecoder();
  const text = decoder.decode(bytes) + decoder.end();
  return { text, invalid: decoder.invalid };
}
