import { mkdtempSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treePaths } from '@open-ancestry/db';
import { importGedcom } from '@open-ancestry/import';
import { zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { startServer } from './index';

/*
 * Issue #198: a GEDZIP export of a tree with gigabytes of media must not hold
 * them in memory or stall the event loop. Sparse files stand in for 2 GB of
 * photos without using disk.
 */

const root = mkdtempSync(join(tmpdir(), 'oa-gdz-big-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FILES = 4;
const SIZE = 512 * 1024 * 1024;

describe('GEDZIP export of a large media library', () => {
  it('streams 2 GB with bounded memory while /api/health stays fast', async () => {
    const lines = ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '0 @I1@ INDI', '1 NAME Odile /Fernsby/'];
    const zipped: Record<string, Uint8Array> = {};
    for (let i = 0; i < FILES; i++) {
      lines.push(`1 OBJE`, `2 FILE scans/scan${i}.jpg`);
      zipped[`scans/scan${i}.jpg`] = new Uint8Array([0xff, 0xd8, 0xff, i]);
    }
    lines.push('0 TRLR', '');
    zipped['gedcom.ged'] = new TextEncoder().encode(lines.join('\n'));
    const dir = join(root, 'Big.oatree');
    await importGedcom({ gedzip: zipSync(zipped) }, { dir });
    // Grow each media file to 512 MB without writing it (sparse).
    for (let i = 0; i < FILES; i++) {
      truncateSync(join(treePaths(dir).media, 'scans', `scan${i}.jpg`), SIZE);
    }

    const server = await startServer({ library: root });
    try {
      const baseline = process.memoryUsage().rss;
      let peak = baseline;
      const health: number[] = [];
      let done = false;
      const probe = (async () => {
        while (!done) {
          const t = performance.now();
          await (await fetch(`${server.url}/api/health`)).json();
          health.push(performance.now() - t);
          peak = Math.max(peak, process.memoryUsage().rss);
          await new Promise((r) => setTimeout(r, 50));
        }
      })();
      const res = await fetch(`${server.url}/api/trees/Big/export.gdz`);
      expect(res.status).toBe(200);
      let received = 0;
      for await (const chunk of res.body!) received += (chunk as Uint8Array).byteLength;
      done = true;
      await probe;
      expect(received).toBeGreaterThan(FILES * SIZE);
      expect(peak - baseline).toBeLessThan(200 * 1024 * 1024);
      expect(health.length).toBeGreaterThan(5);
      expect(Math.max(...health)).toBeLessThan(100);
    } finally {
      await server.close();
    }
  }, 180_000);
});
