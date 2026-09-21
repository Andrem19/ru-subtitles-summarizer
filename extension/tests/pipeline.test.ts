// Integration test: processSubtitlePlaylist against a local HTTP server with
// the exact playlist/segment shapes observed on Kaltura players.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { processSubtitlePlaylist, processVttUrl } from '../src/background/pipeline';

const fixtures = path.join(process.cwd(), 'tests', 'fixtures');
const read = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

async function withServer(handler: (req: { url: string }, res: { end: (b: string) => void; code: (n: number) => void }) => void, fn: (port: number) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    const end = (body: string) => {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(body);
    };
    handler({ url: req.url ?? '' }, { end, code: (n) => { res.writeHead(n); res.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('processSubtitlePlaylist fetches all segments, dedupes boundary cues', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/p/4091/hls/entryId/0_abcd12gh/captions.m3u8') {
        res.end(read('captions.m3u8'));
      } else if (req.url?.startsWith('/p/4091/hls/entryId/0_abcd12gh/segmentIndex/1.vtt')) {
        res.end(read('seg1.vtt'));
      } else if (req.url?.startsWith('/p/4091/hls/entryId/0_abcd12gh/segmentIndex/2.vtt')) {
        res.end(read('seg2.vtt'));
      } else if (req.url?.startsWith('/p/4091/hls/entryId/0_abcd12gh/segmentIndex/3.vtt')) {
        res.end(read('seg3.vtt'));
      } else {
        res.code(404);
      }
    },
    async (port) => {
      const url = `http://127.0.0.1:${port}/p/4091/hls/entryId/0_abcd12gh/captions.m3u8`;
      const src = await processSubtitlePlaylist(url);
      assert.equal(src.entryId, '0_abcd12gh');
      assert.equal(src.segmentCount, 3);
      assert.equal(src.failedSegments.length, 0);
      // seg1 has 2 cues, seg2 has 2 (first duplicates seg1's last), seg3 has 2 -> 5 unique
      assert.equal(src.cues.length, 5);
      assert.ok(Math.abs(src.totalDuration - 778) < 0.001);
      // original timestamps preserved verbatim
      assert.equal(src.cues[0].start, 297.755);
      assert.equal(src.cues[0].end, 300.144);
      assert.ok(src.cues[3].text.includes('styled'));
    },
  );
});

test('missing segment is reported in failedSegments, rest still parses', async () => {
  await withServer(
    (req, res) => {
      if (req.url?.endsWith('.m3u8')) res.end(read('captions.m3u8'));
      else if (req.url?.includes('2.vtt')) res.code(404);
      else if (req.url?.includes('1.vtt')) res.end(read('seg1.vtt'));
      else if (req.url?.includes('3.vtt')) res.end(read('seg3.vtt'));
      else res.code(404);
    },
    async (port) => {
      const url = `http://127.0.0.1:${port}/p/4091/hls/entryId/0_abcd12gh/captions.m3u8`;
      const src = await processSubtitlePlaylist(url);
      assert.equal(src.failedSegments.length, 1);
      assert.ok(src.cues.length >= 3);
    },
  );
});

test('processVttUrl parses a direct WebVTT caption file', async () => {
  await withServer(
    (req, res) => res.end(read('seg1.vtt')),
    async (port) => {
      const src = await processVttUrl(`http://127.0.0.1:${port}/p/1/entryId/0_abcd12gh/caption_en.vtt`);
      assert.equal(src.entryId, '0_abcd12gh');
      assert.equal(src.cues.length, 2);
    },
  );
});
