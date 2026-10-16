import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Library } from './library';
import { testApi, type TestApi } from './test/helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

/** Whether the temp folder's file system ignores case (macOS and Windows defaults). */
function caseInsensitive(): boolean {
  const dir = makeTempDir('oa-case-');
  return existsSync(join(dir.toUpperCase() === dir ? dir.toLowerCase() : dir.toUpperCase()));
}

describe('renaming a tree to another spelling of its name (#275 M8)', () => {
  it.runIf(caseInsensitive())('changes only the case of a tree name', async () => {
    api = await testApi();
    expect((await api.post('/api/trees', { name: 'quillfeather' })).statusCode).toBe(201);
    const res = await api.patch('/api/trees/quillfeather', { name: 'Quillfeather' });
    // Fixing the capitalization of a name is an ordinary rename, not a conflict with itself.
    expect(res.statusCode).toBe(200);
    expect(res.json().tree).toMatchObject({ id: 'Quillfeather', name: 'Quillfeather' });
  });

  it('renames a tree to the decomposed spelling of its own name as a no-op', async () => {
    api = await testApi();
    const nfc = 'Zoë'.normalize('NFC');
    expect((await api.post('/api/trees', { name: nfc })).statusCode).toBe(201);
    const res = await api.patch(`/api/trees/${encodeURIComponent(nfc)}`, {
      name: nfc.normalize('NFD'),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('a rename interrupted between its two steps (#289)', () => {
  // A case-only rename goes old -> .renaming-<uuid>.oatree -> new; a crash in
  // between left the tree under a hidden name that list() skips.
  function interrupted(marker: object | null) {
    const root = makeTempDir('oa-renaming-');
    const library = new Library(root);
    library.create('Quill');
    library.closeAll();
    const temp = join(root, '.renaming-0b0c0d0e-0000-4000-8000-000000000000.oatree');
    renameSync(join(root, 'Quill.oatree'), temp);
    if (marker) writeFileSync(join(temp, '.rename-to'), JSON.stringify(marker));
    return { root, library: new Library(root), temp };
  }

  it('finishes the rename at startup', () => {
    const { library, temp } = interrupted({ from: 'Quill', to: 'QUILL' });
    expect(library.recoverRenames()).toEqual(['QUILL']);
    expect(library.list().map((t) => t.id)).toEqual(['QUILL']);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(join(library.dirOf('QUILL'), '.rename-to'))).toBe(false);
    library.closeAll();
  });

  it('falls back to the old name when the new one is taken, or unknown', () => {
    const taken = interrupted({ from: 'Quill', to: 'Other' });
    mkdirSync(join(taken.root, 'Other.oatree'));
    expect(taken.library.recoverRenames()).toEqual(['Quill']);
    taken.library.closeAll();
    // No marker: the name stored in the tree itself.
    const bare = interrupted(null);
    expect(bare.library.recoverRenames()).toEqual(['Quill']);
    expect(bare.library.list().map((t) => t.id)).toEqual(['Quill']);
    bare.library.closeAll();
  });
});
