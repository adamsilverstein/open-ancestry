import type { GedcomNode, HeaderInfo } from './types';

const child = (node: GedcomNode | undefined, tag: string) =>
  node?.children.find((c) => c.tag === tag);
const text = (node: GedcomNode | undefined, tag: string) => child(node, tag)?.value;

/** Summarizes HEAD: GEDCOM version, charset, source system (Ancestry details) and v7 SCHMA tags. */
export function analyzeHeader(head: GedcomNode | undefined): HeaderInfo {
  const header: HeaderInfo = { schema: {} };
  if (!head) return header;

  const gedc = child(head, 'GEDC');
  const version = text(gedc, 'VERS');
  if (version !== undefined) {
    header.version = version;
    const major = parseInt(version, 10);
    if (major > 0) header.majorVersion = major;
  }
  assign(header, 'form', text(gedc, 'FORM'));
  assign(header, 'charset', text(head, 'CHAR'));

  const sour = child(head, 'SOUR');
  if (sour?.value !== undefined) {
    header.source = { system: sour.value };
    assign(header.source, 'name', text(sour, 'NAME'));
    assign(header.source, 'version', text(sour, 'VERS'));
    assign(header.source, 'corp', text(sour, 'CORP'));
    assign(header.source, 'data', text(sour, 'DATA'));
    if (/^Ancestry\.com/i.test(sour.value)) {
      const tree = child(sour, '_TREE');
      header.ancestry = {};
      assign(header.ancestry, 'treeName', tree?.value ?? text(sour, 'DATA'));
      assign(header.ancestry, 'treeId', text(tree, 'RIN'));
      assign(header.ancestry, 'env', text(tree, '_ENV'));
    }
  }

  assign(header, 'destination', text(head, 'DEST'));
  assign(header, 'date', text(head, 'DATE'));
  assign(header, 'language', text(head, 'LANG'));
  assign(header, 'filename', text(head, 'FILE'));
  assign(header, 'submitter', child(head, 'SUBM')?.pointer);

  for (const tag of child(head, 'SCHMA')?.children ?? []) {
    const [name, uri] = tag.tag === 'TAG' ? (tag.value ?? '').split(' ') : [];
    if (name && uri) header.schema[name] = uri;
  }
  return header;
}

function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) target[key] = value;
}
