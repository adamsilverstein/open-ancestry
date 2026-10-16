import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { MUTATION_HEADERS, seed, testApi, type TestApi } from './test/helpers';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

const boundary = '----oa-adv-boundary';
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('deleting a tree while a photo upload is streaming (#275 L7)', () => {
  it('leaves no tree folder behind and does not answer 500', async () => {
    api = await testApi();
    const { ada } = await seed(api);
    const body = new PassThrough();
    const upload = api.inject({
      method: 'POST',
      url: '/api/trees/Test/media',
      headers: { ...MUTATION_HEADERS, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    const field = (name: string, value: string) =>
      `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    body.write(field('owner_type', 'person') + field('owner_id', ada));
    body.write(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="scan.bin"\r\ncontent-type: application/octet-stream\r\n\r\n`,
    );
    body.write(Buffer.alloc(64 * 1024, 7));
    await tick();
    // The user deletes the tree (or renames it) while the slow upload is still arriving.
    const deleted = await api.del('/api/trees/Test');
    expect(deleted.statusCode).toBe(204);
    body.end(Buffer.concat([Buffer.alloc(1024, 7), Buffer.from(`\r\n--${boundary}--\r\n`)]));
    const res = await upload;
    const folders = readdirSync(api.root).filter((n) => !n.startsWith('.'));
    // The deleted tree must not come back as a media-only folder.
    expect(folders).toEqual([]);
    expect(existsSync(join(api.root, 'Test.oatree'))).toBe(false);
    expect(res.statusCode, res.body).toBeLessThan(500);
  });
});
