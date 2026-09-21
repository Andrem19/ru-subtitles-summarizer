import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseVideoIndex, type VideoCandidate } from '../src/content/assoc';

const cand = (o: Partial<VideoCandidate> = {}): VideoCandidate => ({
  duration: null,
  playing: false,
  claimedBy: null,
  ...o,
});

test('single video is chosen regardless of duration', () => {
  assert.equal(chooseVideoIndex([cand()], { totalDuration: 778, requestId: 'r1' }), 0);
});

test('duration match wins among several videos', () => {
  const vids = [
    cand({ duration: 778 }), // Part A playlist length
    cand({ duration: 2029 }), // Part B
    cand({ duration: 600 }),
  ];
  assert.equal(chooseVideoIndex(vids, { totalDuration: 778, requestId: 'r1' }), 0);
  assert.equal(chooseVideoIndex(vids, { totalDuration: 2029, requestId: 'r2' }), 1);
});

test('unclaimed video preferred when durations tie (unknown durations, one playing)', () => {
  const vids = [cand({ claimedBy: 'r1' }), cand({ playing: true })];
  assert.equal(chooseVideoIndex(vids, { totalDuration: 100, requestId: 'r2' }), 1);
});

test('claimed-by-self video keeps its claim', () => {
  const vids = [cand({ duration: 100, claimedBy: 'r2' }), cand({ duration: 100 })];
  assert.equal(chooseVideoIndex(vids, { totalDuration: 100, requestId: 'r2' }), 0);
});

test('close durations resolve to the better match; tolerance avoids thrash', () => {
  const vids = [cand({ duration: 770 }), cand({ duration: 778 })];
  // 778 matches second exactly
  assert.equal(chooseVideoIndex(vids, { totalDuration: 778, requestId: 'r1' }), 1);
});

test('no durations anywhere: playing and unclaimed preferred, then DOM order', () => {
  const vids = [cand(), cand({ playing: true }), cand()];
  assert.equal(chooseVideoIndex(vids, { totalDuration: 0, requestId: 'r1' }), 1);
});
