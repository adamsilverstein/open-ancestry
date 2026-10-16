import { readdirSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { treePaths } from '@open-ancestry/db';
import { importGedcom } from '@open-ancestry/import';
import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { startServer } from './index';
import { makeTempDir } from '../../../fixtures/temp-dir';

/*
 * Issue #198: a GEDZIP export of a tree with gigabytes of media must not hold
 * them in memory or stall the event loop. Sparse files stand in for 2 GB of
 * photos without using disk.
 */

const root = makeTempDir('oa-gdz-big-');

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
      // The client reading 2 GB shares this event loop, and the machine may be
      // busy: hold the 95th percentile to the 100ms budget.
      const sorted = [...health].sort((x, y) => x - y);
      expect(sorted[Math.floor(sorted.length * 0.95)]).toBeLessThan(100);
    } finally {
      await server.close();
    }
  }, 180_000);

  it('refuses an archive over 4 GiB with a clear message instead of a broken file', async () => {
    const dir = join(root, 'Huge.oatree');
    await importGedcom(
      {
        gedzip: zipSync({
          'gedcom.ged': new TextEncoder().encode(
            '0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 @I1@ INDI\n1 OBJE\n2 FILE film.mp4\n0 TRLR\n',
          ),
          'film.mp4': new Uint8Array([0, 0, 0, 1]),
        }),
      },
      { dir },
    );
    truncateSync(join(treePaths(dir).media, 'film.mp4'), 5 * 1024 ** 3);
    const server = await startServer({ library: root });
    try {
      const res = await fetch(`${server.url}/api/trees/Huge/export.gdz`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
        /largest archive this export can write/,
      );
    } finally {
      await server.close();
    }
  });

  it('closes the media file when the client hangs up mid-download', async () => {
    const dir = join(root, 'Hangup.oatree');
    await importGedcom(
      {
        gedzip: zipSync({
          'gedcom.ged': new TextEncoder().encode(
            '0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 @I1@ INDI\n1 OBJE\n2 FILE scan.jpg\n0 TRLR\n',
          ),
          'scan.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0]),
        }),
      },
      { dir },
    );
    truncateSync(join(treePaths(dir).media, 'scan.jpg'), 256 * 1024 * 1024);
    const server = await startServer({ library: root });
    try {
      const openFds = () => readdirSync('/dev/fd').length;
      const before = openFds();
      const controller = new AbortController();
      const res = await fetch(`${server.url}/api/trees/Hangup/export.gdz`, {
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      let received = 0;
      while (received < 8 * 1024 * 1024) received += (await reader.read()).value!.byteLength;
      controller.abort();
      await reader.cancel().catch(() => {});
      await vi.waitFor(() => expect(openFds()).toBeLessThanOrEqual(before), { timeout: 5000 });
    } finally {
      await server.close();
    }
  });
});
