import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBatches, splitBatch, type WeightedItem } from '../src/shared/batching';

const mk = (n: number, textLen = 20): WeightedItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i}`, text: 'x'.repeat(textLen), start: i * 2 }));

test('batching respects maxItems', () => {
  const batches = buildBatches(mk(95), { maxItems: 40, maxChars: 10_000 });
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((b) => b.items.length), [40, 40, 15]);
});

test('batching respects maxChars', () => {
  const batches = buildBatches(mk(10, 100), { maxItems: 100, maxChars: 350 });
  // cost per item = 112 chars -> 3 per batch
  assert.deepEqual(batches.map((b) => b.items.length), [3, 3, 3, 1]);
});

test('batch keeps earliest start time for prioritization', () => {
  const batches = buildBatches(mk(5), { maxItems: 3, maxChars: 10_000 });
  assert.equal(batches[0].startTime, 0);
  assert.equal(batches[1].startTime, 6);
});

test('splitBatch halves and preserves startTime', () => {
  const [a, b] = splitBatch({ index: 1, items: mk(7).map(({ id, text }) => ({ id, text })), startTime: 42 });
  assert.equal(a.items.length, 4);
  assert.equal(b.items.length, 3);
  assert.equal(a.startTime, 42);
  assert.equal(b.startTime, 42);
});

test('empty input produces no batches', () => {
  assert.equal(buildBatches([]).length, 0);
});
