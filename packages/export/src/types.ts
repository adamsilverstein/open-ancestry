export type GedcomVersion = '5.5.1' | '7';

export interface GedcomExportOptions {
  /** Output version (default 5.5.1, the format Ancestry reads). */
  version?: GedcomVersion;
  /** Living people become "Private" with only their family links; nothing else about them is written. */
  privatizeLiving?: boolean;
  /** Write media records and links (default true). */
  includeMedia?: boolean;
  /** Export time for HEAD.DATE (default now). */
  now?: Date;
}

export interface GedcomExport {
  text: string;
  /** The xref written for each exported row, by row id. */
  xrefs: Map<string, string>;
  /** Records copied from raw_record and records generated from the domain tables. */
  stats: { verbatim: number; generated: number };
}

export type GedzipExportOptions = Omit<GedcomExportOptions, 'version' | 'includeMedia'>;

export interface GedzipExport extends GedcomExport {
  bytes: Uint8Array;
  /** Media files that could not be added (missing, outside the media folder). */
  warnings: string[];
}
