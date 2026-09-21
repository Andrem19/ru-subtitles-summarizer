import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeVttUrl, parseAttributes, parseHls, resolveUrl } from '../src/shared/hls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const fixture = (name: string) => readFileSync(path.join(process.cwd(), 'tests', 'fixtures', name), 'utf8');

test('subtitle playlist: segments, durations, classification', () => {
  const base = 'https://cfvod.kaltura.com/p/123/sp/12300/hls/entryId/0_abcd12gh/';
  const pl = parseHls(fixture('captions.m3u8'), base + 'captions.srt.m3u8');
  assert.equal(pl.isMaster, false);
  assert.equal(pl.isSubtitlePlaylist, true);
  assert.equal(pl.segments.length, 3);
  assert.ok(looksLikeVttUrl(pl.segments[0].uri));
  assert.equal(pl.segments[0].uri, new URL('segmentIndex/1.vtt', base).toString());
  assert.equal(pl.segments[2].duration, 178.0);
  assert.ok(Math.abs(pl.totalDuration - 778) < 0.001);
});

test('seven-segment playlist totals 2029s', () => {
  const pl = parseHls(fixture('captions7.m3u8'), 'https://x.example/c.m3u8');
  assert.equal(pl.segments.length, 7);
  assert.equal(pl.totalDuration, 300 * 6 + 229);
});

test('video media playlist is not a subtitle playlist', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXTINF:9.0,',
    'chunklist0/seq-1.ts',
    '#EXTINF:9.0,',
    'chunklist0/seq-2.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const pl = parseHls(text, 'https://cdn.example/video.m3u8');
  assert.equal(pl.isSubtitlePlaylist, false);
  assert.equal(pl.segments.length, 2);
});

test('master playlist: SUBTITLES variants are collected, variant URIs resolved', () => {
  const base = 'https://cdn.example/master.m3u8';
  const text = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="avc1",SUBTITLES="subs"',
    'v5/prog_index.m3u8',
  ].join('\n');
  const pl = parseHls(text, base);
  assert.equal(pl.isMaster, true);
  assert.equal(pl.subtitleVariants.length, 1);
  assert.equal(pl.subtitleVariants[0].language, 'en');
  assert.equal(pl.subtitleVariants[0].uri, 'https://cdn.example/subs/en.m3u8');
  assert.equal(pl.variants[0].uri, 'https://cdn.example/v5/prog_index.m3u8');
});

test('resolveUrl handles absolute, relative and query URLs', () => {
  const base = 'https://cdn.example/a/b/playlist.m3u8';
  assert.equal(resolveUrl(base, 'seg/1.vtt'), 'https://cdn.example/a/b/seg/1.vtt');
  assert.equal(resolveUrl(base, '/root/1.vtt'), 'https://cdn.example/root/1.vtt');
  assert.equal(resolveUrl(base, 'https://other.example/x.vtt'), 'https://other.example/x.vtt');
});

test('parseAttributes parses quoted values with commas', () => {
  const attrs = parseAttributes('TYPE=SUBTITLES,NAME="Lectures, part 1",LANGUAGE="en"');
  assert.equal(attrs.get('TYPE'), 'SUBTITLES');
  assert.equal(attrs.get('NAME'), 'Lectures, part 1');
  assert.equal(attrs.get('LANGUAGE'), 'en');
});
