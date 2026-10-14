import { AnselDecoder } from './ansel';
import type { EncodingInfo, GedcomEncoding, GedcomWarning } from './types';

export { decodeAnsel } from './ansel';

/** Bytes scanned for BOM, `HEAD.CHAR` and sniffing. */
export const DETECT_BYTES = 64 * 1024;

const CHARSETS: Record<string, GedcomEncoding> = {
  'UTF-8': 'utf-8',
  UTF8: 'utf-8',
  ANSEL: 'ansel',
  ASCII: 'ascii',
  'US-ASCII': 'ascii',
  ANSI: 'windows-1252',
  'WINDOWS-1252': 'windows-1252',
  CP1252: 'windows-1252',
  'ISO-8859-1': 'windows-1252',
  'ISO8859-1': 'windows-1252',
  LATIN1: 'windows-1252',
  // IBM PC code page 437 has no WHATWG decoder; CP1252 gets the ASCII range right.
  IBMPC: 'windows-1252',
  MACINTOSH: 'macintosh',
};

function hasBom(bytes: Uint8Array): GedcomEncoding | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return undefined;
}

/** Length of the byte order mark at the start of `bytes` if it matches `encoding`. */
export function bomLength(bytes: Uint8Array, encoding: GedcomEncoding): number {
  const bom = hasBom(bytes);
  if (bom !== encoding && !(bom === 'utf-8' && encoding === 'ascii')) return 0;
  return bom === 'utf-8' ? 3 : 2;
}

export function isValidUtf8(bytes: Uint8Array, truncated: boolean): boolean {
  try {
    // `stream` tolerates a multi-byte sequence cut off at the end of a prefix.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
    return true;
  } catch {
    return false;
  }
}

/** Reads `HEAD.CHAR` and `HEAD.GEDC.VERS` from the ASCII-compatible start of the file. */
function scanHeader(bytes: Uint8Array): { charset?: string; version?: string } {
  const prefix = new TextDecoder('windows-1252').decode(bytes.subarray(0, DETECT_BYTES));
  // Only look inside the HEAD record, which may follow stray lines.
  const start = Math.max(0, prefix.search(/(?:^|[\r\n])[ \t]*0[ \t]+HEAD/));
  const rest = prefix.slice(start + 1);
  const end = rest.search(/[\r\n][ \t]*0[ \t]/);
  const head = end === -1 ? rest : rest.slice(0, end);
  return {
    charset: /^[ \t]*1[ \t]+CHAR[ \t]+(\S+)/m.exec(head)?.[1],
    version: /^[ \t]*2[ \t]+VERS[ \t]+(\S+)/m.exec(head.slice(head.search(/GEDC/)))?.[1],
  };
}

/**
 * Picks the encoding for a GEDCOM byte stream from its first bytes. Order:
 * explicit option, BOM, `HEAD.CHAR`, then sniffing (UTF-16 byte patterns,
 * UTF-8 validity, CP1252 as the last resort).
 */
export function detectEncoding(
  bytes: Uint8Array,
  options: { encoding?: GedcomEncoding; complete?: boolean } = {},
): EncodingInfo {
  const bomEncoding = hasBom(bytes);
  const bom = bomEncoding !== undefined;
  const utf16 = bomEncoding === 'utf-16le' || bomEncoding === 'utf-16be';
  const { charset: declared, version } = utf16 ? {} : scanHeader(bytes);
  const info = (encoding: GedcomEncoding, source: EncodingInfo['source']): EncodingInfo => ({
    encoding,
    source,
    ...(declared !== undefined && { declared }),
    bom,
  });

  if (options.encoding) return info(options.encoding, 'option');
  if (bomEncoding) return info(bomEncoding, 'bom');
  if (bytes[0] === 0x30 && bytes[1] === 0) return info('utf-16le', 'sniff');
  if (bytes[0] === 0 && bytes[1] === 0x30) return info('utf-16be', 'sniff');

  // GEDCOM 7 is always UTF-8 and has no CHAR.
  const mapped =
    declared && !version?.startsWith('7') ? CHARSETS[declared.toUpperCase()] : undefined;
  if (mapped) return info(mapped, 'header');

  const prefix = bytes.subarray(0, DETECT_BYTES);
  const truncated = !options.complete || bytes.length > DETECT_BYTES;
  return info(isValidUtf8(prefix, truncated) ? 'utf-8' : 'windows-1252', 'sniff');
}

/** Streaming decoder that counts bytes it could not map. */
export interface ChunkDecoder {
  decode(bytes: Uint8Array): string;
  end(): string;
  invalidBytes(): number;
}

/** Counts U+FFFD in output that did not come from a literal EF BF BD in the input. */
class TextChunkDecoder implements ChunkDecoder {
  private readonly decoder: InstanceType<typeof TextDecoder>;
  private readonly utf8: boolean;
  private replacements = 0;
  private literal = 0;
  /** Last two bytes of the previous chunk, to find a literal split across chunks. */
  private tail = new Uint8Array(0);

  constructor(label: string) {
    this.decoder = new TextDecoder(label, { ignoreBOM: true });
    this.utf8 = label === 'utf-8';
  }

  private count(text: string): string {
    for (let i = text.indexOf('\uFFFD'); i !== -1; i = text.indexOf('\uFFFD', i + 1)) {
      this.replacements++;
    }
    return text;
  }

  private countLiteral(bytes: Uint8Array) {
    const edge = new Uint8Array([...this.tail, ...bytes.subarray(0, 2)]);
    for (const scan of [edge, bytes]) {
      for (let i = scan.indexOf(0xef); i !== -1; i = scan.indexOf(0xef, i + 1)) {
        if (scan[i + 1] === 0xbf && scan[i + 2] === 0xbd) this.literal++;
      }
    }
    // A literal entirely inside the first two bytes of `bytes` is impossible, so no double count.
    this.tail = bytes.slice(Math.max(0, bytes.length - 2));
  }

  decode(bytes: Uint8Array): string {
    const text = this.count(this.decoder.decode(bytes, { stream: true }));
    if (this.utf8) this.countLiteral(bytes);
    return text;
  }

  end(): string {
    return this.count(this.decoder.decode());
  }

  invalidBytes(): number {
    return Math.max(0, this.replacements - this.literal);
  }
}

class AnselChunkDecoder implements ChunkDecoder {
  private decoder = new AnselDecoder();
  decode(bytes: Uint8Array): string {
    return this.decoder.decode(bytes);
  }
  end(): string {
    return this.decoder.end();
  }
  invalidBytes(): number {
    return this.decoder.invalid;
  }
}

/** ASCII files often contain UTF-8 or CP1252 anyway; they decode as UTF-8 here. */
export function createDecoder(encoding: GedcomEncoding): ChunkDecoder {
  if (encoding === 'ansel') return new AnselChunkDecoder();
  return new TextChunkDecoder(encoding === 'ascii' ? 'utf-8' : encoding);
}

export interface DecodeResult {
  text: string;
  encoding: EncodingInfo;
  warnings: GedcomWarning[];
}

export function invalidBytesWarning(count: number, encoding: GedcomEncoding): GedcomWarning {
  return {
    code: 'invalid-bytes',
    line: 0,
    message: `${count} byte(s) invalid for ${encoding} were replaced with U+FFFD`,
  };
}

export function asciiFallbackWarning(): GedcomWarning {
  return {
    code: 'encoding-fallback',
    line: 0,
    message: 'File declares ASCII but is not valid UTF-8; decoded as Windows-1252',
  };
}

export function mismatchWarnings(info: EncodingInfo): GedcomWarning[] {
  if (!info.bom || info.declared === undefined) return [];
  const declared = CHARSETS[info.declared.toUpperCase()];
  const compatible =
    info.declared.toUpperCase() === 'UNICODE'
      ? info.encoding !== 'utf-8'
      : declared === info.encoding;
  if (compatible || (info.encoding === 'utf-8' && declared === 'ascii')) return [];
  return [
    {
      code: 'charset-mismatch',
      line: 0,
      message: `HEAD.CHAR says ${info.declared} but the byte order mark says ${info.encoding}; using ${info.encoding}`,
    },
  ];
}

/** Decodes a whole GEDCOM file to a string without its BOM. Never throws. */
export function decodeGedcom(
  bytes: Uint8Array,
  options: { encoding?: GedcomEncoding } = {},
): DecodeResult {
  let encoding = detectEncoding(bytes, { ...options, complete: true });
  const warnings = mismatchWarnings(encoding);
  const body = bytes.subarray(bomLength(bytes, encoding.encoding));

  if (encoding.encoding === 'ascii' && !isValidUtf8(body, false)) {
    encoding = { ...encoding, encoding: 'windows-1252' };
    warnings.push(asciiFallbackWarning());
  }

  const decoder = createDecoder(encoding.encoding);
  const text = decoder.decode(body) + decoder.end();
  const invalid = decoder.invalidBytes();
  if (invalid > 0) warnings.push(invalidBytesWarning(invalid, encoding.encoding));
  return { text, encoding, warnings };
}
