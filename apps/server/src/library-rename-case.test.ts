import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
