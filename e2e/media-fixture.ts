import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { createTree, createUlidFactory, type InsertRow } from '@open-ancestry/db';

/*
 * The media e2e tree: invented people with local photos (real PNGs), a PDF,
 * Ancestry placeholders that must never be fetched, and one person with 400
 * placeholders for the virtualized gallery.
 */

export const MEDIA_TREE = 'media-fixture';
export const REMOTE_HOST = 'mediasvc.ancestry.com';
/** Links a hostile GEDCOM could carry; none may become a link. */
export const HOSTILE_URLS = [
  'javascript:alert(document.domain)',
  'https://evil.example/ancestry.com/x.jpg',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
];

const fixedId = createUlidFactory({ now: () => 1_760_000_000_000, random: () => 3 });
export const MEDIA_IDS = {
  imogen: fixedId(),
  many: fixedId(),
  hostile: fixedId(),
  imogenBirth: fixedId(),
  mill: fixedId(),
  wedding: fixedId(),
  harvest: fixedId(),
  christening: fixedId(),
  baptism: fixedId(),
  census: fixedId(),
  /** People with profile photos for the tree view: a local file, an Ancestry placeholder. */
  pippa: fixedId(),
  pippaPortrait: fixedId(),
  quill: fixedId(),
  quillPlaceholder: fixedId(),
};

export const PHOTO_TITLES = ['Imogen at the mill', 'Wedding day', 'Harvest 1922'];

const photo = (color: string, width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();

/** Writes the media tree into `library` (replacing an earlier copy). */
export async function buildMediaTree(library: string): Promise<void> {
  const dir = join(library, `${MEDIA_TREE}.oatree`);
  rmSync(dir, { recursive: true, force: true });
  const store = createTree(dir, { name: 'Larch family (media)' });
  const media = join(dir, 'media', 'photos');
  mkdirSync(media, { recursive: true });
  const files: [string, Buffer][] = [
    ['mill.png', await photo('#6b8f71', 640, 480)],
    ['wedding.png', await photo('#b0402c', 480, 640)],
    ['harvest.png', await photo('#d9a441', 800, 500)],
    ['christening.png', await photo('#4a6fa5', 500, 500)],
    ['portrait.png', await photo('#7a5c99', 1200, 1600)],
    ['baptism.pdf', Buffer.from('%PDF-1.4\n% synthetic baptism record\n')],
  ];
  for (const [name, bytes] of files) writeFileSync(join(media, name), bytes);

  const id = MEDIA_IDS;
  store.transact('media fixture', (tx) => {
    const person = (personId: string, given: string, surname: string) => {
      tx.insert('person', { id: personId, sex: 'F', living: 'inferred_dead' });
      tx.insert('person_name', {
        person_id: personId,
        given,
        surname,
        full_text: `${given} /${surname}/`,
        is_primary: 1,
      });
    };
    person(id.imogen, 'Imogen', 'Larch');
    person(id.many, 'Marta', 'Plenty');
    person(id.hostile, 'Hal', 'Hostile');
    tx.insert('event', {
      id: id.imogenBirth,
      type: 'BIRT',
      date_text: '1898',
      date_sort: 18980701,
    });
    tx.insert('event_role', { event_id: id.imogenBirth, person_id: id.imogen });

    const add = (
      row: InsertRow<'media'> & { id: string },
      owner: string,
      type: 'person' | 'event' = 'person',
      order = 0,
    ) => {
      tx.insert('media', row);
      tx.insert('media_link', {
        media_id: row.id,
        owner_type: type,
        owner_id: owner,
        sort_order: order,
      });
    };
    const local = (key: keyof typeof id, file: string, title: string, order: number) =>
      add(
        { id: id[key], kind: 'photo', mime: 'image/png', local_path: `photos/${file}`, title },
        id.imogen,
        'person',
        order,
      );
    local('mill', 'mill.png', PHOTO_TITLES[0]!, 0);
    local('wedding', 'wedding.png', PHOTO_TITLES[1]!, 1);
    local('harvest', 'harvest.png', PHOTO_TITLES[2]!, 2);
    add(
      {
        id: id.baptism,
        kind: 'document',
        mime: 'application/pdf',
        local_path: 'photos/baptism.pdf',
        title: 'Baptism record',
      },
      id.imogen,
      'person',
      3,
    );
    add(
      {
        id: id.census,
        kind: 'photo',
        remote_url: `https://${REMOTE_HOST}/v2/image/namespaces/1093/media/0a1b2c3d-0000-4000-8000-000000000099.jpg`,
        ancestry_oid: '0a1b2c3d-0000-4000-8000-000000000099',
        title: '1911 census page',
        date_text: '1911',
      },
      id.imogen,
      'person',
      4,
    );
    add(
      {
        id: id.christening,
        kind: 'photo',
        mime: 'image/png',
        local_path: 'photos/christening.png',
        title: 'Christening portrait',
      },
      id.imogenBirth,
      'event',
    );
    HOSTILE_URLS.forEach((url, i) =>
      add(
        { id: fixedId(), kind: 'photo', remote_url: url, title: `Hostile link ${i + 1}` },
        id.hostile,
        'person',
        i,
      ),
    );
    for (let i = 0; i < 400; i++) {
      add(
        {
          id: fixedId(),
          kind: 'photo',
          remote_url: `https://${REMOTE_HOST}/many/${i}.jpg`,
          ancestry_oid: `oid-${i}`,
          title: `Placeholder ${i + 1}`,
        },
        id.many,
        'person',
        i,
      );
    }
    const withPhoto = (
      personId: string,
      given: string,
      mediaRow: InsertRow<'media'> & { id: string },
    ) => {
      add(mediaRow, personId);
      person(personId, given, 'Larch');
      tx.update('person', personId, { primary_media_id: mediaRow.id });
    };
    withPhoto(id.pippa, 'Pippa', {
      id: id.pippaPortrait,
      kind: 'photo',
      mime: 'image/png',
      local_path: 'photos/portrait.png',
      title: 'Pippa portrait',
    });
    withPhoto(id.quill, 'Quill', {
      id: id.quillPlaceholder,
      kind: 'photo',
      remote_url: `https://${REMOTE_HOST}/quill.jpg`,
      ancestry_oid: 'oid-quill',
      title: 'Quill (Ancestry only)',
    });
    tx.insert('meta', { key: 'home_person_id', value: id.imogen });
  });
  store.close();
}
