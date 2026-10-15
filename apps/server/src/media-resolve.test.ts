import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveMediaPath, resolveMediaPathSync } from './routes/media';

/*
 * Both media resolvers must agree on every case (#207): the async one serves
 * media and thumbnails, the sync one checks profile photos inside a
 * transaction. Each case builds a tree folder and says what `local_path`
 * should resolve to, relative to the tree, or null when it must be refused.
 */

let base: string;
let tree: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'oa-media-resolve-')));
  tree = join(base, 'Tree.oatree');
  outside = join(base, 'outside');
  await mkdir(join(tree, 'thumbs'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'secret.jpg'), 'secret');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

interface Case {
  name: string;
  /** Builds the case; returns [media root, local path]. */
  setup: () => Promise<[root: string, localPath: string]>;
  /** Expected resolved path relative to the tree folder, or null. */
  expected: string | null;
}

const media = () => join(tree, 'media');
const plainMedia = async () => {
  await mkdir(join(media(), 'photos'), { recursive: true });
  await writeFile(join(media(), 'photos', 'a.jpg'), 'a');
};

const cases: Case[] = [
  {
    name: 'a file inside media/',
    setup: async () => (await plainMedia(), [media(), 'photos/a.jpg']),
    expected: 'media/photos/a.jpg',
  },
  {
    name: 'a path that climbs out of media/',
    setup: async () => (await plainMedia(), [media(), '../thumbs']),
    expected: null,
  },
  {
    name: 'a missing file',
    setup: async () => (await plainMedia(), [media(), 'photos/missing.jpg']),
    expected: null,
  },
  {
    name: 'a symlink to a file outside the tree',
    setup: async () => {
      await plainMedia();
      await symlink(join(outside, 'secret.jpg'), join(media(), 'link.jpg'));
      return [media(), 'link.jpg'];
    },
    expected: null,
  },
  {
    name: 'a symlink to another file inside media/',
    setup: async () => {
      await plainMedia();
      await symlink(join(media(), 'photos', 'a.jpg'), join(media(), 'alias.jpg'));
      return [media(), 'alias.jpg'];
    },
    expected: 'media/photos/a.jpg',
  },
  {
    name: 'a hard link to a file outside the tree',
    setup: async () => {
      await plainMedia();
      await link(join(outside, 'secret.jpg'), join(media(), 'hard.jpg'));
      return [media(), 'hard.jpg'];
    },
    expected: null,
  },
  {
    // Which side of a hard link is the original cannot be told, so any second link is refused.
    name: 'a file with a second hard link inside media/',
    setup: async () => {
      await plainMedia();
      await link(join(media(), 'photos', 'a.jpg'), join(media(), 'photos', 'b.jpg'));
      return [media(), 'photos/a.jpg'];
    },
    expected: null,
  },
  {
    name: 'media/ itself a symlink out of the tree',
    setup: async () => {
      await mkdir(join(outside, 'photos'));
      await writeFile(join(outside, 'photos', 'a.jpg'), 'a');
      await symlink(outside, media());
      return [media(), 'photos/a.jpg'];
    },
    expected: null,
  },
  {
    name: 'media/ itself a symlink to another folder in the tree',
    setup: async () => {
      await mkdir(join(tree, 'elsewhere'));
      await writeFile(join(tree, 'elsewhere', 'a.jpg'), 'a');
      await symlink(join(tree, 'elsewhere'), media());
      return [media(), 'a.jpg'];
    },
    expected: null,
  },
  {
    name: 'a thumbnail under thumbs/ (resolved from the tree folder)',
    setup: async () => {
      await writeFile(join(tree, 'thumbs', 'm-200.webp'), 't');
      return [tree, 'thumbs/m-200.webp'];
    },
    expected: 'thumbs/m-200.webp',
  },
  {
    name: 'thumbs/ itself a symlink out of the tree',
    setup: async () => {
      await rm(join(tree, 'thumbs'), { recursive: true });
      await writeFile(join(outside, 'm-200.webp'), 't');
      await symlink(outside, join(tree, 'thumbs'));
      return [tree, 'thumbs/m-200.webp'];
    },
    expected: null,
  },
];

describe('media path resolvers', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const [root, localPath] = await c.setup();
    const expected = c.expected === null ? null : join(tree, c.expected);
    const sync = resolveMediaPathSync(root, localPath);
    const async = await resolveMediaPath(root, localPath);
    expect(async).toBe(expected);
    expect(sync).toBe(async);
  });
});
