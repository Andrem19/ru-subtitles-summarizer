import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCues, parseTimestamp, parseVtt } from '../src/shared/vtt';

test('timestamps: full, short, comma decimal', () => {
  assert.equal(parseTimestamp('01:02:03.456'), 3723.456);
  assert.equal(parseTimestamp('05:02.5'), 302.5);
  assert.equal(parseTimestamp('00:00:03,040'), 3.04);
  assert.equal(parseTimestamp('bogus'), null);
});

test('task sample VTT parses into cues with exact original timing', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:04:57.755 --> 00:05:00.144',
    'but they do travel',
    'at a finite speed.',
    '',
    '00:05:00.144 --> 00:05:02.529',
    'And the practical',
    'limit on that speed',
    '',
  ].join('\n');
  const cues = parseVtt(vtt);
  assert.equal(cues.length, 2);
  assert.deepEqual(
    [cues[0].start, cues[0].end],
    [297.755, 300.144],
  );
  assert.equal(cues[0].text, 'but they do travel\nat a finite speed.');
  assert.equal(cues[1].start, 300.144);
});

test('handles cue ids, NOTE blocks, inline tags and entities', () => {
  const vtt = [
    'WEBVTT - Some header text',
    '',
    'STYLE',
    '::cue { color: red }',
    '',
    'NOTE this is a comment',
    'spanning lines',
    '',
    'cue-1',
    '00:00:01.000 --> 00:00:02.000 line:0%',
    'Hello <i>world</i> &amp; friends',
    '',
    '00:00:03.000 --> 00:00:04.000',
    '<v Speaker>A voice',
    '',
  ].join('\n');
  const cues = parseVtt(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello world & friends');
  assert.equal(cues[1].text, 'A voice');
});

test('concatenated segments without blank line between cues still parse', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:02.000',
    'first',
    '00:00:02.000 --> 00:00:03.000',
    'second',
  ].join('\n');
  const cues = parseVtt(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[1].text, 'second');
});

test('normalizeCues removes boundary duplicates across HLS segments and sorts', () => {
  const merged = normalizeCues([
    { start: 300.144, end: 302.529, text: 'And the practical\nlimit on that speed' },
    { start: 297.755, end: 300.144, text: 'but they do travel\nat a finite speed.' },
    { start: 300.144, end: 302.529, text: 'And the practical\nlimit on that speed' },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].start, 297.755);
  assert.equal(merged[1].start, 300.144);
});
