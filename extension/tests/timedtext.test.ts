import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJson3, parseTimedText, parseTimedTextXml } from '../src/shared/timedtext';

test('json3: events with segments convert to cues in seconds', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 1500, dDurationMs: 2300, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
      { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: 'Second' }, { utf8: '\n' }, { utf8: 'line' }] },
      { tStartMs: 6000, segs: [] },
      { tStartMs: 6500, dDurationMs: 1000 },
    ],
  });
  const cues = parseJson3(body);
  assert.equal(cues.length, 2);
  assert.deepEqual([cues[0].start, cues[0].end], [1.5, 3.8]);
  assert.equal(cues[0].text, 'Hello world');
  assert.equal(cues[1].text, 'Second line');
});

test('xml: legacy transcript format with entities', () => {
  const body =
    '<transcript><text start="0.5" dur="2">Roll &amp; scroll</text>' +
    '<text start="2.5" dur="1.5">Tom &amp; Jerry &lt;3</text></transcript>';
  const cues = parseTimedTextXml(body);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Roll & scroll');
  assert.deepEqual([cues[1].start, cues[1].end], [2.5, 4]);
  assert.equal(cues[1].text, 'Tom & Jerry <3');
});

test('auto-detect: json, xml and empty bodies', () => {
  assert.equal(parseTimedText('').length, 0);
  assert.equal(parseTimedText('   ').length, 0);
  assert.equal(parseTimedText('<transcript></transcript>').length, 0);
  assert.equal(parseTimedText(JSON.stringify({ events: [] })).length, 0);
  const json = parseTimedText(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'x' }] }] }));
  assert.equal(json[0].text, 'x');
});

test('malformed json returns empty instead of throwing', () => {
  assert.deepEqual(parseJson3('{"events": '), []);
});
